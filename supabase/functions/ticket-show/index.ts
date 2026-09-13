import { secured } from "../_shared/security.ts";
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
//
// A day pass is the same object seen from further back: one `MFF-D-` code over
// several ticket rows, one per screening of the day. It is shown as a single
// pass with the list of doors it opens, never as a handful of tickets.

import { db } from "../_shared/db.ts";
import { fail, json, preflight } from "../_shared/http.ts";

const TICKET_COLS =
  "code, order_id, screening, holder_name, badge_code, tariff, wheelchair, checked_in_at, cancelled_at";

Deno.serve(secured(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "GET") return fail(req, "method_not_allowed", 405);

  try {
    const url = new URL(req.url);
    const code = (url.searchParams.get("c") ?? "").trim().toUpperCase();
    const orderId = (url.searchParams.get("o") ?? "").trim();

    if (code && !/^MFF-[TD]-[A-Z0-9]{8}$/.test(code)) return fail(req, "unknown_ticket", 404);
    if (orderId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) return fail(req, "unknown_order", 404);
    if (code) {
      return json(req, code.startsWith("MFF-D-") ? await onePass(code) : await oneTicket(code));
    }
    if (orderId) return json(req, await wholeOrder(orderId));
    return fail(req, "code_required");
  } catch (e) {
    console.error("ticket-show", e);
    return fail(req, "server_error", 500, String(e));
  }
}, {"scope":"ticket-show","methods":["GET"],"limit":120,"globalLimit":1500}));

// An order still sitting in `held` is a checkout nobody finished, and its codes
// must not look like admission — so validity is read from the order, never from
// the ticket row alone.
async function orderStatus(id: string): Promise<string | null> {
  const { data } = await db().from("ticket_orders").select("status").eq("id", id).maybeSingle();
  return data?.status ?? null;
}

function state(status: string | null, cancelled: string | null, usedAt: string | null) {
  if (cancelled) return "cancelled";
  if (status !== "issued") return "pending";
  return usedAt ? "used" : "valid";
}

async function oneTicket(code: string) {
  const { data: ticket } = await db()
    .from("tickets").select(TICKET_COLS).eq("code", code).maybeSingle();
  if (!ticket) return { ok: false, error: "unknown_ticket" };

  const status = await orderStatus(ticket.order_id);

  return {
    ok: true,
    ticket: {
      code: ticket.code,
      holder: ticket.holder_name,
      badge: ticket.badge_code,
      tariff: ticket.tariff,
      wheelchair: ticket.wheelchair,
      valid: status === "issued" && !ticket.cancelled_at,
      status: state(status, ticket.cancelled_at, ticket.checked_in_at),
      checked_in_at: ticket.checked_in_at,
    },
    screening: await screening(ticket.screening),
  };
}

async function onePass(code: string) {
  const { data: rows } = await db()
    .from("tickets").select(TICKET_COLS)
    .eq("day_pass_code", code).order("created_at", { ascending: true });
  if (!rows?.length) return { ok: false, error: "unknown_ticket" };

  const status = await orderStatus(rows[0].order_id);
  const live = rows.filter((r) => !r.cancelled_at);

  const { data: shows } = await db()
    .from("screenings").select("code, title, venue, starts_at")
    .in("code", live.map((r) => r.screening))
    .order("starts_at", { ascending: true });

  // The pass is spent per door, so "used" here means the holder is inside the
  // screening that is running — not that the day is over.
  const usedAt = live.map((r) => r.checked_in_at).filter(Boolean).sort().pop() ?? null;

  return {
    ok: true,
    ticket: {
      code,
      holder: rows[0].holder_name,
      badge: null,
      tariff: rows[0].tariff,
      wheelchair: rows[0].wheelchair,
      day_pass: true,
      valid: status === "issued" && live.length > 0,
      status: state(status, live.length ? null : "cancelled", null),
      checked_in_at: usedAt,
    },
    screening: shows?.[0] ?? null,
    screenings: (shows ?? []).map((s) => ({
      ...s,
      used: live.find((r) => r.screening === s.code)?.checked_in_at ?? null,
    })),
  };
}

async function wholeOrder(orderId: string) {
  const { data: order } = await db()
    .from("ticket_orders")
    .select("id, status, screening, day")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return { ok: false, error: "unknown_order" };

  // Only an issued order has codes worth showing: while it is still `held` the
  // page is waiting for the webhook, and saying nothing is the honest answer.
  const rows = order.status === "issued"
    ? (await db()
      .from("tickets")
      .select("code, day_pass_code")
      .eq("order_id", orderId)
      .is("cancelled_at", null)
      .order("created_at", { ascending: true })).data ?? []
    : [];

  // A day-pass order holds one row per screening per person but only one code
  // per person, so it is the passes that are listed, deduplicated.
  const codes = order.day
    ? [...new Set(rows.map((t) => t.day_pass_code).filter(Boolean) as string[])]
    : rows.map((t) => t.code);

  return {
    ok: true,
    status: order.status,
    day: order.day,
    codes,
    screening: order.screening ? await screening(order.screening) : null,
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
