import { createMailSession, validMailSession } from "../_shared/mail-session.ts";
import { passwordMatches } from "../_shared/request.ts";
import { rateLimit, secured } from "../_shared/security.ts";
// POST /functions/v1/ticket-mail
//
// Ticket emails, sent when the festival decides. The site mails a booking the
// moment it is made; anything seated another way — the directors and their
// guests reserved in one batch, a school's day passes placed on a screening —
// never had that moment, so it sits in the database with `email_sent_at` empty
// and its holders have nothing in their inbox. Two actions, one password:
//
//   list — issued orders, already grouped the way they will be mailed: one group
//          per recipient and screening (or day). A teacher whose forty seats were
//          booked in four batches is one group, and gets one message.
//   send — mail the chosen orders. One that already had its email is left alone
//          unless `resend` is set, so sending the same list twice, or "every
//          order still waiting", never floods anyone.
//
// There is no page in front of it: it is called from a terminal, when someone
// organising the festival says who should get their tickets now. Its own
// password (TICKET_MAIL_PASSWORD), not the box office's: `list` returns names
// and email addresses, and the door password is told across a counter to
// whoever is on shift.
//
//   curl -s "$SUPABASE_URL/functions/v1/ticket-mail" -H 'content-type: application/json' \
//     -d '{"password":"…","action":"list","q":"siragusa"}'
//   … -d '{"session":"…","action":"send","order_ids":["…","…"]}'

import { db } from "../_shared/db.ts";
import { fail, json, preflight } from "../_shared/http.ts";
import { emailTicketGroup, type MailOrder, ORDER_COLUMNS } from "../_shared/ticket-mail.ts";

// One request stays well inside the function's wall clock even at Resend's
// pace; a longer list goes out in several calls.
const MAX_GROUPS_PER_SEND = 25;
const MAX_ORDERS_PER_SEND = 200;
// Resend allows a couple of requests a second per account.
const SEND_SPACING_MS = 600;
const HOLDERS_SHOWN = 6;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Listed = MailOrder & {
  created_at: string;
  tickets: { holder_name: string | null; cancelled_at: string | null }[] | null;
  day_passes: { holder_name: string | null; cancelled_at: string | null }[] | null;
};

// The unit a message is made of: one inbox, one screening or one day.
function groupKey(o: MailOrder): string {
  return `${o.email.toLowerCase()}|${o.screening ? `s:${o.screening}` : `d:${o.day}`}`;
}

function groupBy<T extends MailOrder>(orders: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const o of orders) {
    const key = groupKey(o);
    groups.set(key, [...(groups.get(key) ?? []), o]);
  }
  return groups;
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(secured(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "method_not_allowed", 405);

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return fail(req, "bad_request");

    const expected = Deno.env.get("TICKET_MAIL_PASSWORD");
    if (!expected) return fail(req, "service_unavailable", 503);
    let session = body.session;
    if (!await validMailSession(session, expected)) {
      if (session && !body.password) return fail(req, "unauthorised", 401);
      // Limit BEFORE comparing, as at the door: otherwise unlimited guesses could
      // still tell a right password from a 429.
      const blocked = await rateLimit(req, "mail-login", 10, 100, 300);
      if (blocked) return blocked;
      if (!passwordMatches(body.password, expected)) return fail(req, "unauthorised", 401);
      session = await createMailSession(expected);
    }

    const action = body.action ?? "list";
    if (action === "list") return json(req, { ok: true, session, ...await list(body) });
    if (action === "send") {
      const sent = await send(body);
      if ("error" in sent) return fail(req, sent.error);
      return json(req, { ok: true, session, ...sent });
    }
    return fail(req, "bad_request");
  } catch (e) {
    console.error("ticket-mail", e);
    return fail(req, "server_error", 500, String(e));
  }
}, { scope: "ticket-mail", methods: ["POST"] }));

// --- list -------------------------------------------------------------------

async function list(body: Record<string, unknown>) {
  const event = String(body.event ?? "").trim();
  const unsent = body.unsent !== false;
  // Matched here rather than in the query: the filter also looks at the names on
  // the seats, so a teacher is found by any of their pupils, and nothing typed
  // into the box ever becomes PostgREST syntax.
  const q = String(body.q ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .trim().slice(0, 60);

  let query = db()
    .from("ticket_orders")
    .select(`${ORDER_COLUMNS}, created_at, tickets(holder_name, cancelled_at), day_passes(holder_name, cancelled_at)`)
    .eq("status", "issued");
  if (unsent) query = query.is("email_sent_at", null);
  if (/^s:[a-z0-9][a-z0-9-]{1,23}$/.test(event)) query = query.eq("screening", event.slice(2));
  else if (/^d:\d{4}-\d{2}-\d{2}$/.test(event)) query = query.eq("day", event.slice(2));

  const [{ data: orders, error }, { data: shows }, { data: days }] = await Promise.all([
    query.order("created_at", { ascending: true }).limit(1000),
    db().from("screenings").select("code, title, starts_at")
      .eq("is_published", true).eq("is_ticketed", true).order("starts_at", { ascending: true }),
    db().from("festival_days").select("day").order("day", { ascending: true }),
  ]);
  if (error) throw new Error(error.message);

  const titles = new Map((shows ?? []).map((s) => [s.code, s]));
  const plain = (s: string | null) =>
    (s ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");

  const groups = [];
  for (const [key, members] of groupBy((orders ?? []) as Listed[])) {
    const lead = members[0];
    // A day order's email lists its passes; a screening order's, its seats.
    const holders = members.flatMap((o) =>
      ((lead.day ? o.day_passes : o.tickets) ?? []).filter((t) => !t.cancelled_at)
        .map((t) => t.holder_name ?? "")
    );
    if (!holders.length) continue;

    if (q) {
      const hay = [lead.email, ...members.flatMap((o) => [o.first_name, o.last_name]), ...holders]
        .map(plain).join(" ");
      if (!q.split(/\s+/).every((word) => hay.includes(word))) continue;
    }

    const show = lead.screening ? titles.get(lead.screening) : null;
    const sent = members.map((o) => o.email_sent_at).filter(Boolean).sort() as string[];
    groups.push({
      key,
      email: lead.email,
      name: `${lead.first_name} ${lead.last_name}`,
      event: lead.screening ? `s:${lead.screening}` : `d:${lead.day}`,
      title: show?.title ?? (lead.screening ?? `Giornaliera · ${lead.day}`),
      starts_at: show?.starts_at ?? `${lead.day}T00:00:00+02:00`,
      order_ids: members.map((o) => o.id),
      tickets: holders.length,
      holders: holders.filter(Boolean).slice(0, HOLDERS_SHOWN),
      unsent: members.filter((o) => !o.email_sent_at).length,
      sent_at: sent.at(-1) ?? null,
      // Orders from before 13 September 2026 predate `email_sent_at`: empty
      // there does not mean the email never went out.
      booked_at: lead.created_at,
    });
  }
  groups.sort((a, b) => a.starts_at.localeCompare(b.starts_at) || a.name.localeCompare(b.name, "it"));

  return {
    groups,
    truncated: (orders?.length ?? 0) >= 1000,
    events: [
      ...(shows ?? []).map((s) => ({ value: `s:${s.code}`, title: s.title, starts_at: s.starts_at })),
      ...(days ?? []).map((d) => ({ value: `d:${d.day}`, title: `Giornaliere · ${d.day}`, starts_at: `${d.day}T00:00:00+02:00` })),
    ],
  };
}

// --- send -------------------------------------------------------------------

type Sent = { email: string; order_ids: string[]; tickets: number; status: string; error: string | null };

async function send(body: Record<string, unknown>): Promise<{ error: string } | { results: Sent[]; skipped: number }> {
  const raw = body.order_ids;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ORDERS_PER_SEND ||
      !raw.every((id) => typeof id === "string" && UUID.test(id))) {
    return { error: "orders_required" };
  }
  const ids = [...new Set(raw.map((id) => (id as string).toLowerCase()))];
  const resend = body.resend === true;
  const requestId = typeof body.request_id === "string" && UUID.test(body.request_id)
    ? body.request_id
    : crypto.randomUUID();

  const { data, error } = await db().from("ticket_orders").select(ORDER_COLUMNS).in("id", ids);
  if (error) throw new Error(error.message);
  const orders = ((data ?? []) as MailOrder[])
    .filter((o) => o.status === "issued" && (resend || !o.email_sent_at));

  const groups = [...groupBy(orders).values()];
  if (groups.length > MAX_GROUPS_PER_SEND) return { error: "too_many_groups" };

  const results: Sent[] = [];
  for (const [i, members] of groups.entries()) {
    if (i) await new Promise((r) => setTimeout(r, SEND_SPACING_MS));
    const orderIds = members.map((o) => o.id).sort();
    // The same selection sent twice (a double tap, a retried request) is one
    // email: Resend drops a repeated key for a day. A deliberate resend carries
    // the click's own id, so it goes out again as intended.
    const key = `ticket-mail/${await sha256(orderIds.join(",") + (resend ? `|${requestId}` : ""))}`;
    const row: Sent = { email: members[0].email, order_ids: orderIds, tickets: 0, status: "sent", error: null };
    try {
      row.tickets = await emailTicketGroup(members, key);
      if (!row.tickets) row.status = "empty";
    } catch (e) {
      console.error("ticket-mail send", e);
      row.status = "failed";
      row.error = String(e).slice(0, 200);
    }
    results.push(row);
  }

  return { results, skipped: ids.length - orders.length };
}
