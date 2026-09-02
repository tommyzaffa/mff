// GET /functions/v1/ticket-show?c=<ticket code>
// GET /functions/v1/ticket-show?o=<order id>
//
// What a ticket holder is allowed to see about their own booking. Two lookups
// rather than two endpoints, because they answer the same question from either
// end of the same object: `c` is the link in the email, `o` is where Stripe
// sends the customer back.
//
// The code is the credential — there is nothing else to present at the door —
// so the reply carries only what a ticket has to show: the screening, the name
// printed on it and whether it is still valid. No email address, no order total,
// nothing about the party's other seats.

import { db } from "../_shared/db.ts";
import { fail, json, preflight } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "GET") return fail(req, "method_not_allowed", 405);

  try {
    const url = new URL(req.url);
    const code = (url.searchParams.get("c") ?? "").trim().toUpperCase();
    const orderId = (url.searchParams.get("o") ?? "").trim();

    if (code) return json(req, await oneTicket(code));
    if (orderId) return json(req, await wholeOrder(orderId));
    return fail(req, "code_required");
  } catch (e) {
    console.error("ticket-show", e);
    return fail(req, "server_error", 500, String(e));
  }
});

async function oneTicket(code: string) {
  const { data: ticket } = await db()
    .from("tickets")
    .select("code, order_id, screening, holder_name, badge_code, wheelchair, checked_in_at, cancelled_at")
    .eq("code", code)
    .maybeSingle();
  if (!ticket) return { ok: false, error: "unknown_ticket" };

  // A ticket is only real once its order is: an order still sitting in `held`
  // is a checkout nobody finished, and its codes must not look like admission.
  const { data: order } = await db()
    .from("ticket_orders")
    .select("status")
    .eq("id", ticket.order_id)
    .maybeSingle();

  const show = await screening(ticket.screening);

  return {
    ok: true,
    ticket: {
      code: ticket.code,
      holder: ticket.holder_name,
      badge: ticket.badge_code,
      wheelchair: ticket.wheelchair,
      valid: order?.status === "issued" && !ticket.cancelled_at,
      status: ticket.cancelled_at
        ? "cancelled"
        : order?.status === "issued"
        ? (ticket.checked_in_at ? "used" : "valid")
        : "pending",
      checked_in_at: ticket.checked_in_at,
    },
    screening: show,
  };
}

async function wholeOrder(orderId: string) {
  const { data: order } = await db()
    .from("ticket_orders")
    .select("id, status, screening")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return { ok: false, error: "unknown_order" };

  // Only an issued order has codes worth showing: while it is still `held` the
  // page is waiting for the webhook, and saying nothing is the honest answer.
  const codes = order.status === "issued"
    ? (await db()
        .from("tickets")
        .select("code")
        .eq("order_id", orderId)
        .is("cancelled_at", null)
        .order("created_at", { ascending: true })).data ?? []
    : [];

  return {
    ok: true,
    status: order.status,
    codes: codes.map((t) => t.code),
    screening: await screening(order.screening),
  };
}

async function screening(code: string) {
  const { data } = await db()
    .from("screenings")
    .select("code, title, venue, starts_at")
    .eq("code", code)
    .maybeSingle();
  return data ?? null;
}
