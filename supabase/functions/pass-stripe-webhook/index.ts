import { paymentMatches } from "../_shared/request.ts";
import { secured } from "../_shared/security.ts";
// POST /functions/v1/pass-stripe-webhook
//
// Stripe is the only thing that may tell us something was paid for — the success
// page cannot be trusted, since anyone can open it with any id. Two events
// matter, and they mean something slightly different for each product:
//
//   checkout.session.completed  passes  -> claim a badge number and send it
//                               tickets -> confirm the seats and send them
//   checkout.session.expired    passes  -> give a limited access code its seat back
//                               tickets -> put the seats back in the room
//
// Both live here rather than on two endpoints so there is a single signature
// check and a single place in the codebase allowed to decide something is paid.
// Retries are expected, so everything below is safe to run twice.

import { db, logEvent, type Pass } from "../_shared/db.ts";
import { issuePass } from "../_shared/issue.ts";
import { emailTickets } from "../_shared/ticket-mail.ts";
import { verifyWebhook } from "../_shared/stripe.ts";

Deno.serve(secured(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  // The raw body, byte for byte: re-serialising it would break the signature.
  const payload = await req.text();

  if (!(await verifyWebhook(payload, req.headers.get("stripe-signature")))) {
    return new Response("Bad signature", { status: 400 });
  }

  let event: { type: string; data: { object: Record<string, unknown> } };
  try {
    event = JSON.parse(payload);
  } catch {
    return new Response("Bad payload", { status: 400 });
  }

  try {
    const session = event.data.object;
    const meta = (session.metadata as Record<string, string> | null) ?? {};

    // Seat reservations ride the same endpoint. One webhook to register with
    // Stripe, one signature check, and one place in the codebase that is allowed
    // to decide something was paid for.
    if (meta.kind === "ticket" || meta.order_id) {
      const orderId = meta.order_id ?? (session.client_reference_id as string | null);
      if (orderId) await ticketOrder(event.type, session, orderId);
      return ok();
    }

    const passId = meta.pass_id ?? (session.client_reference_id as string | null);
    if (!passId) return ok();

    const { data } = await db().from("passes").select("*").eq("id", passId).maybeSingle();
    if (!data) return ok();
    const pass = data as Pass;

    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      // `paid` and not, say, `processing`: TWINT and some cards settle
      // asynchronously, and we only hand out a badge once the money is there.
      if (session.payment_status !== "paid") {
        await logEvent(passId, "paid", `pending: ${String(session.payment_status)}`, "stripe");
        return ok();
      }

      // A pass we already withdrew must not come back to life because an old
      // checkout link was finally opened and paid.
      if (pass.status !== "awaiting_payment" && pass.status !== "paid") {
        await logEvent(passId, "error", `paid while ${pass.status}, ignored`, "stripe");
        return ok();
      }

      // The session has to be the one we opened for this pass, and it has to
      // carry the price we asked for. Only our own account can produce a
      // correctly signed event, so this is belt and braces — but the belt is
      // what stops a stale or mismatched session from issuing a badge.
      if (!paymentMatches(session, pass)) {
        await logEvent(passId, "error", "payment/session/currency mismatch", "stripe");
        return ok();
      }

      const { data: paid, error: paidError } = await db().from("passes").update({
        status: "paid",
        paid_at: new Date().toISOString(),
        stripe_payment_intent: (session.payment_intent as string) ?? null,
        stripe_session_id: (session.id as string) ?? pass.stripe_session_id,
      }).eq("id", passId).in("status", ["awaiting_payment", "paid"]).select("id");
      if (paidError) throw new Error("payment persistence failed");
      if (!paid?.length) return ok();

      await logEvent(passId, "paid", `${session.amount_total} ${session.currency}`, "stripe");
      await issuePass({ ...pass, status: "paid" }, "stripe");
      return ok();
    }

    if (event.type === "checkout.session.expired") {
      // Only reopen a pass that never got anywhere; an issued one is untouchable.
      if (pass.status === "awaiting_payment" && session.id === pass.stripe_session_id) {
        const { error } = await db().from("passes").update({ status: "cancelled" }).eq("id", passId).eq("status", "awaiting_payment");
        if (error) throw new Error("expiry persistence failed");
        if (pass.access_code) {
          await db().rpc("pass_release_access_code", { p_code: pass.access_code });
        }
        await logEvent(passId, "error", "checkout expired, pass cancelled", "stripe");
      }
      return ok();
    }

    return ok();
  } catch (e) {
    console.error("pass-stripe-webhook", e);
    // A 500 makes Stripe retry, which is what we want for a transient failure.
    return new Response("Handler failed", { status: 500 });
  }
}, {"scope":"pass-stripe-webhook","methods":["POST"],"maxBytes":262144}));

// --- seat reservations ------------------------------------------------------

// The seats are already held by the order, so a completed payment only has to
// promote it and send the tickets. An expired session has to hand the seats
// back at once: waiting for the hold to lapse would keep a busy screening
// looking fuller than it is.
async function ticketOrder(
  type: string,
  session: Record<string, unknown>,
  orderId: string,
): Promise<void> {
  const { data: order } = await db()
    .from("ticket_orders")
    .select("id, status, amount_cents, stripe_session_id")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return;

  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(type)) {
    // TWINT and some cards settle asynchronously; seats are only confirmed once
    // the money is actually there, not when the customer leaves the page.
    if (session.payment_status !== "paid") return;
    if (!paymentMatches(session, order)) {
      console.error(`ticket order ${orderId}: payment/session/currency mismatch`);
      return;
    }

    const { data: issued, error: issueError } = await db().rpc("ticket_order_issue", {
      p_id: orderId,
      p_intent: (session.payment_intent as string) ?? null,
    });

    if (issueError) throw new Error("ticket issue failed");
    if (!issued?.ok) {
      console.error(`PAID_ORDER_NOT_ISSUED ${orderId}: ${issued?.reason}`);
      // Let Stripe retry and surface the paid order for manual refund/reconciliation.
      throw new Error("paid order needs reconciliation");
    }

    // The persisted delivery marker and provider idempotency key allow an
    // already-issued order to recover from an earlier email outage.
    if (!await emailTickets(orderId)) throw new Error("ticket email unavailable");
    return;
  }

  if (type === "checkout.session.expired" && order.status === "held" && session.id === order.stripe_session_id) {
    await db().rpc("ticket_order_cancel", { p_id: orderId });
  }
}

function ok() {
  return new Response(JSON.stringify({ received: true }), {
    headers: { "content-type": "application/json" },
  });
}
