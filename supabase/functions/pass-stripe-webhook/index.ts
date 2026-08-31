// POST /functions/v1/pass-stripe-webhook
//
// Stripe is the only thing that may tell us a pass was paid for — the success
// page cannot be trusted, since anyone can open it with any pass id. Two events
// matter:
//
//   checkout.session.completed  -> mark paid, claim a badge number, send it
//   checkout.session.expired    -> give a limited access code its seat back
//
// Retries are expected, so everything below is safe to run twice.

import { db, logEvent, type Pass } from "../_shared/db.ts";
import { issuePass } from "../_shared/issue.ts";
import { verifyWebhook } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
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
    const passId = (session.metadata as Record<string, string> | null)?.pass_id ??
      (session.client_reference_id as string | null);
    if (!passId) return ok();

    const { data } = await db().from("passes").select("*").eq("id", passId).maybeSingle();
    if (!data) return ok();
    const pass = data as Pass;

    if (event.type === "checkout.session.completed") {
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
      if (pass.stripe_session_id && session.id !== pass.stripe_session_id) {
        await logEvent(passId, "error", `session mismatch: ${String(session.id)}`, "stripe");
        return ok();
      }
      if (Number(session.amount_total ?? 0) < pass.amount_cents) {
        await logEvent(passId, "error", `underpaid: ${String(session.amount_total)}`, "stripe");
        return ok();
      }

      await db().from("passes").update({
        status: "paid",
        paid_at: new Date().toISOString(),
        stripe_payment_intent: (session.payment_intent as string) ?? null,
        stripe_session_id: (session.id as string) ?? pass.stripe_session_id,
      }).eq("id", passId);

      await logEvent(passId, "paid", `${session.amount_total} ${session.currency}`, "stripe");
      await issuePass({ ...pass, status: "paid" }, "stripe");
      return ok();
    }

    if (event.type === "checkout.session.expired") {
      // Only reopen a pass that never got anywhere; an issued one is untouchable.
      if (pass.status === "awaiting_payment") {
        await db().from("passes").update({ status: "cancelled" }).eq("id", passId);
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
});

function ok() {
  return new Response(JSON.stringify({ received: true }), {
    headers: { "content-type": "application/json" },
  });
}
