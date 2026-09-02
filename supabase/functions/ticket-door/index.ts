// POST /functions/v1/ticket-door
//
// The Lux box office's own page. Two actions, both behind one shared password:
//
//   board — what is on today, and how many seats each screening still has
//   sell  — append +1 / -1 to a screening's door ledger
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

import { db } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { fail, json, preflight } from "../_shared/http.ts";

// A screening stays on the board until it has been running a while, so the
// counter does not vanish from under someone still selling latecomers.
const KEEP_VISIBLE_MINUTES = 45;
const LOOK_AHEAD_HOURS = 18;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "method_not_allowed", 405);

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return fail(req, "bad_request");

    if (!authorised(String(body.password ?? ""))) {
      // Deliberately vague and deliberately slow: this is a short passphrase
      // shared by a shift, so the one defence worth having is making a guessing
      // run expensive.
      await new Promise((r) => setTimeout(r, 700));
      return fail(req, "unauthorised", 401);
    }

    if (body.action === "sell") {
      const screening = String(body.screening ?? "").trim();
      const delta = Number(body.delta);
      if (!screening) return fail(req, "screening_required");
      if (!Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 20) {
        return fail(req, "bad_delta");
      }

      const { error } = await db().from("screening_door_sales").insert({
        screening,
        delta,
        actor: String(body.actor ?? "").trim().slice(0, 40) || "cassa",
      });
      if (error) return fail(req, "server_error", 500, error.message);
    }

    return json(req, { ok: true, screenings: await board() });
  } catch (e) {
    console.error("ticket-door", e);
    return fail(req, "server_error", 500, String(e));
  }
});

function authorised(given: string): boolean {
  const expected = env.doorPassword();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function board() {
  // Seats held by checkouts nobody finished are given back before counting, so
  // the number on the wall at the box office is not quietly too low.
  await db().rpc("ticket_expire_holds");

  const now = Date.now();
  const from = new Date(now - KEEP_VISIBLE_MINUTES * 60_000).toISOString();
  const to = new Date(now + LOOK_AHEAD_HOURS * 3_600_000).toISOString();

  const { data } = await db()
    .from("screening_availability")
    .select(
      "code, title, venue, starts_at, capacity, price_cents, " +
        "online_taken, door_sold, seats_left, wheelchair_left, sales_close_at",
    )
    .eq("is_published", true)
    .eq("is_ticketed", true)
    .gte("starts_at", from)
    .lte("starts_at", to)
    .order("starts_at", { ascending: true });

  // `unlocked` is the whole rule, computed in one place: the box office may sell
  // a screening only once the site has stopped selling it.
  return (data ?? []).map((s) => ({
    ...s,
    unlocked: new Date(s.sales_close_at).getTime() <= now,
  }));
}
