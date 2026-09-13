import { createDoorSession, validDoorSession } from "../_shared/door-session.ts";
import { passwordMatches } from "../_shared/request.ts";
import { rateLimit } from "../_shared/security.ts";
import { secured } from "../_shared/security.ts";
// POST /functions/v1/ticket-door
//
// The Lux staff's own page. Three actions, all behind one shared password:
//
//   board — what is on today, and how many seats each screening still has
//   sell  — append +1 / -1 to a screening's door ledger
//   scan  — admit one person at the door of the room
//
// The board is the important half. Online sales stop 60 minutes before a
// screening, so from that moment the number here is simply how many tickets the
// cinema may still sell, and nothing anybody types can make it wrong. Screenings
// whose online window is still open come back locked, with the time they open:
// the page enforces the rule so nobody at the counter has to remember it.
//
// `sell` is for our attendance figures, not for the arithmetic — the cinema's
// own till is what actually counts its sales. It is a ledger of movements rather
// than a total precisely because two people on the same shift will tap it at the
// same moment, and a total would let one overwrite the other.
//
// `scan` is the door of the room rather than the counter, and it is the one
// action that decides something about a person standing there. Note the two
// levels of `ok`: the outer one says the request was understood and authorised,
// `scan.ok` says whether to let them in. Collapsing them would let a dropped
// connection read as a refusal, which is exactly the mistake that gets someone
// turned away from a film they paid for.

import { db } from "../_shared/db.ts";
import { fail, json, preflight } from "../_shared/http.ts";

// A screening stays on the board until it has been running a while, so the
// counter does not vanish from under someone still selling latecomers.
const KEEP_VISIBLE_MINUTES = 45;
const LOOK_AHEAD_HOURS = 18;

Deno.serve(secured(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "method_not_allowed", 405);

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return fail(req, "bad_request");

    const expected = Deno.env.get("DOOR_PASSWORD");
    if (!expected) return fail(req, "service_unavailable", 503);
    let session = body.session;
    if (!await validDoorSession(session, expected)) {
      if (session && !body.password) return fail(req, "unauthorised", 401);
      // Limit BEFORE comparing the password. Checking first would still let
      // unlimited guesses distinguish a correct password from a 429 response.
      const blocked = await rateLimit(req, "door-login", 10, 100, 300);
      if (blocked) return blocked;
      if (!passwordMatches(body.password, expected)) return fail(req, "unauthorised", 401);
      session = await createDoorSession(expected);
    }

    if (body.action && !["board", "sell", "scan"].includes(body.action)) return fail(req, "bad_request");

    if (body.action === "scan") {
      const code = String(body.code ?? "").trim();
      const screening = String(body.screening ?? "").trim();
      if (!/^MFF-(?:[TD]-[A-Z0-9]{8}|[A-Z0-9]{4}-[A-Z0-9]{4})$/.test(code)) return fail(req, "code_required");
      // Always sent by the page, because a check-in that does not know which
      // door it is standing at cannot refuse the wrong film.
      if (!/^[a-z0-9][a-z0-9-]{1,23}$/.test(screening)) return fail(req, "screening_required");

      const { data, error } = await db().rpc("ticket_check_in", {
        p_code: code,
        p_screening: screening,
      });
      if (error) return fail(req, "server_error", 500, error.message);
      return json(req, { ok: true, scan: data });
    }

    if (body.action === "sell") {
      const screening = String(body.screening ?? "").trim();
      const delta = Number(body.delta);
      // Which of the two prices was charged. It changes nothing about the seat
      // count — a seat is a seat — but without it the takings cannot be checked
      // against the till at the end of the night.
      const tariff = body.tariff === "reduced" ? "reduced" : "full";
      if (!/^[a-z0-9][a-z0-9-]{1,23}$/.test(screening)) return fail(req, "screening_required");
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 20) {
        return fail(req, "bad_delta");
      }

      const { data: sale, error } = await db().rpc("ticket_door_sell", {
        p_screening: screening, p_delta: delta, p_tariff: tariff,
        p_actor: String(body.actor ?? "").trim().slice(0, 40) || "cassa",
      });
      if (!error && !sale?.ok) return fail(req, sale?.reason ?? "sale_failed", 409);
      if (error) return fail(req, "server_error", 500, error.message);
    }

    return json(req, { ok: true, session, screenings: await board() });
  } catch (e) {
    console.error("ticket-door", e);
    return fail(req, "server_error", 500, String(e));
  }
}, {"scope":"ticket-door","methods":["POST"]}));

async function board() {
  // Seats held by checkouts nobody finished are given back before counting, so
  // the number on the wall at the box office is not quietly too low.
  await db().rpc("ticket_expire_holds");

  const now = Date.now();
  const from = new Date(now - KEEP_VISIBLE_MINUTES * 60_000).toISOString();
  const to = new Date(now + LOOK_AHEAD_HOURS * 3_600_000).toISOString();

  const { data, error } = await db()
    .from("screening_availability")
    .select(
      "code, title, venue, starts_at, capacity, price_cents, price_reduced_cents, online_taken, door_sold, door_full, door_reduced, seats_left, wheelchair_left, sales_close_at",
    )
    .eq("is_published", true)
    .eq("is_ticketed", true)
    .gte("starts_at", from)
    .lte("starts_at", to)
    .order("starts_at", { ascending: true });

  if (error) throw new Error("availability unavailable");

  // `unlocked` is the whole rule, computed in one place: the box office may sell
  // a screening only once the site has stopped selling it.
  return (data ?? []).map((s) => ({
    ...s,
    unlocked: new Date(s.sales_close_at).getTime() <= now,
  }));
}
