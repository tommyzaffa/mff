// POST /functions/v1/ticket-reserve
//
// Books seats for one screening. A party can mix accredited holders, who pay
// nothing and spend one seat per badge, with paying guests — so the two possible
// answers are:
//
//   reserved — nothing to pay: the tickets are already valid and in their inbox
//   checkout — here is the Stripe URL; the seats are held until it is paid
//
// All the counting, the sales window and the one-badge-one-seat rule live in the
// `ticket_reserve` RPC, under the screening's row lock. This function does not
// second-guess any of it: it validates the shape of the request, calls that once,
// and turns the answer into a payment or an email.

import { db } from "../_shared/db.ts";
import { fail, json, preflight } from "../_shared/http.ts";
import { asLocale } from "../_shared/templates.ts";
import { emailTickets } from "../_shared/ticket-mail.ts";
import { createTicketCheckoutSession } from "../_shared/stripe.ts";

// Stripe will not accept a session expiring in under 30 minutes, so that is the
// floor. The database hold outlives it by five minutes: if the two were equal, a
// payment landing on the last second would find its seats already given away.
const CHECKOUT_MINUTES = 30;
const HOLD_MINUTES = CHECKOUT_MINUTES + 5;

const MAX_SEATS = 10;

type SeatIn = { badge?: string | null; holder?: string | null; wheelchair?: boolean };

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "method_not_allowed", 405);

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return fail(req, "bad_request");

    const screening = String(body.screening ?? "").trim();
    const firstName = String(body.first_name ?? "").trim();
    const lastName = String(body.last_name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const locale = asLocale(body.locale);

    if (!screening) return fail(req, "screening_required");
    if (!firstName || !lastName) return fail(req, "name_required");
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return fail(req, "email_invalid");

    const rawSeats = Array.isArray(body.seats) ? (body.seats as SeatIn[]) : null;
    if (!rawSeats || rawSeats.length < 1) return fail(req, "seats_required");
    if (rawSeats.length > MAX_SEATS) return fail(req, "too_many_seats");

    // Normalised here so the RPC receives exactly the three keys it reads and
    // nothing a caller invented can reach the database.
    const seats = rawSeats.map((s) => ({
      badge: (s?.badge ?? "").toString().trim().toUpperCase() || null,
      holder: (s?.holder ?? "").toString().trim().slice(0, 60) || null,
      wheelchair: s?.wheelchair === true,
    }));

    // Give back anything abandoned on a Stripe page before counting, so a busy
    // screening does not look full because of checkouts nobody finished.
    await db().rpc("ticket_expire_holds");

    const { data: show, error: showErr } = await db()
      .from("screening_availability")
      .select("code, title, venue, starts_at, price_cents")
      .eq("code", screening)
      .maybeSingle();

    if (showErr) return fail(req, "server_error", 500, showErr.message);
    if (!show) return fail(req, "unknown_screening", 404);

    const { data: result, error } = await db().rpc("ticket_reserve", {
      p_screening: screening,
      p_first_name: firstName,
      p_last_name: lastName,
      p_email: email,
      p_seats: seats,
      p_locale: locale,
      p_hold_mins: HOLD_MINUTES,
    });

    if (error) return fail(req, "server_error", 500, error.message);

    // Every refusal the RPC can give is a stable key the page translates. 409
    // because they all mean "the room changed under you", not "you typed wrong".
    if (!result?.ok) {
      return json(req, { ...result, error: result?.reason ?? "reserve_failed" }, 409);
    }

    const orderId = result.order_id as string;

    // --- nothing to pay ------------------------------------------------------
    if (result.free) {
      await emailTickets(orderId);
      return json(req, {
        ok: true,
        outcome: "reserved",
        order_id: orderId,
        codes: result.codes,
      });
    }

    // --- straight to checkout ------------------------------------------------
    const paying = seats.filter((s) => !s.badge).length;

    try {
      const session = await createTicketCheckoutSession({
        orderId,
        screeningTitle: `Merge Film Festival 2026 — ${show.title}`,
        locale,
        email,
        unitAmountCents: show.price_cents,
        quantity: paying,
        holdMinutes: CHECKOUT_MINUTES,
      });

      await db()
        .from("ticket_orders")
        .update({ stripe_session_id: session.id })
        .eq("id", orderId);

      return json(req, { ok: true, outcome: "checkout", url: session.url, order_id: orderId });
    } catch (e) {
      // The seats are already held by an order that can now never be paid for.
      // Hand them straight back rather than making the room wait out the hold.
      await db().rpc("ticket_order_cancel", { p_id: orderId });
      return fail(req, "checkout_failed", 502, String(e));
    }
  } catch (e) {
    console.error("ticket-reserve", e);
    return fail(req, "server_error", 500, String(e));
  }
});
