import { secured } from "../_shared/security.ts";
// POST /functions/v1/ticket-reserve
//
// Books seats, either for one screening or for a whole day. A party can mix
// accredited holders, who pay nothing and spend one seat per badge, with paying
// guests at either tariff — so the two possible answers are:
//
//   reserved — nothing to pay: the tickets are already valid and in their inbox
//   checkout — here is the Stripe URL; the seats are held until it is paid
//
// Send `screening` for a single show or `day` (YYYY-MM-DD) for a day pass; one
// or the other, never both. All the counting, the sales window, the tariff
// prices and the one-badge-one-seat rule live in the RPCs, under the row locks
// of the screenings involved. This function does not second-guess any of it: it
// validates the shape of the request, calls once, and turns the answer into a
// payment or an email.

import { db } from "../_shared/db.ts";
import { fail, json, preflight } from "../_shared/http.ts";
import { asLocale } from "../_shared/templates.ts";
import { emailTickets } from "../_shared/ticket-mail.ts";
import { type CheckoutLine, createTicketCheckoutSession } from "../_shared/stripe.ts";

// Stripe will not accept a session expiring in under 30 minutes, so that is the
// floor. The database hold outlives it by five minutes: if the two were equal, a
// payment landing on the last second would find its seats already given away.
const CHECKOUT_MINUTES = 30;
const HOLD_MINUTES = CHECKOUT_MINUTES + 5;

const MAX_SEATS = 10;

// Only what the buyer is allowed to claim. 'accredited' is not in here: that is
// something the database concludes from a valid badge, never something a
// request can assert.
const TARIFFS = new Set(["full", "reduced"]);

type SeatIn = {
  badge?: string | null;
  holder?: string | null;
  wheelchair?: boolean;
  tariff?: string | null;
};

// Two lines on the receipt at most, one per tariff, so "2 x Ridotto CHF 10"
// reads back as what was actually agreed.
function checkoutLines(
  label: string,
  seats: { badge: string | null; tariff: string }[],
  full: number,
  reduced: number,
): CheckoutLine[] {
  const paying = seats.filter((s) => !s.badge);
  return [
    {
      name: label,
      unitAmountCents: full,
      quantity: paying.filter((s) => s.tariff !== "reduced").length,
    },
    {
      name: `${label} — ridotto / reduced`,
      unitAmountCents: reduced,
      quantity: paying.filter((s) => s.tariff === "reduced").length,
    },
  ];
}

// A badge or day-pass code as the holder actually types it. Trimming is not
// enough: the codes are printed and read back in groups, so they arrive with a
// space inside ("MFF-X73Q -YEQC"), a non-breaking space pasted out of an email,
// or lower case. Every one of those used to come back as "we do not recognise
// this badge", which reads as "your accreditation is not valid" to someone who
// is holding a perfectly good one. Keep only what a code is made of.
function credential(v: unknown): string | null {
  return (v ?? "").toString().toUpperCase().replace(/[^A-Z0-9-]/g, "") || null;
}

Deno.serve(secured(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "method_not_allowed", 405);

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return fail(req, "bad_request");

    const screening = String(body.screening ?? "").trim();
    const day = String(body.day ?? "").trim();
    const firstName = String(body.first_name ?? "").trim();
    const lastName = String(body.last_name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const locale = asLocale(body.locale);
    // An invitation minted in the gestionale. It pays for the whole booking, so
    // it belongs to the order rather than to a seat; the database decides
    // whether it is live, whether it fits this screening or day and how many
    // seats are left on it.
    const invite = String(body.access_code ?? "").trim().toUpperCase() || null;

    // Exactly one of the two. Accepting both would leave the function choosing
    // which the buyer meant, and it would sometimes choose wrong.
    if (!!screening === !!day) return fail(req, "screening_required");
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail(req, "bad_day");
    if (!firstName || !lastName || firstName.length > 60 || lastName.length > 60) return fail(req, "name_required");
    if (email.length > 254 || screening.length > 24) return fail(req, "bad_request");
    // No invitation can be shaped like a festival QR — the table forbids it —
    // so a code that is, or that is not a code at all, is answered without
    // asking the database about it.
    if (invite && (!/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(invite) || invite.startsWith("MFF-"))) {
      return fail(req, "unknown_invite", 409);
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return fail(req, "email_invalid");

    const rawSeats = Array.isArray(body.seats) ? (body.seats as SeatIn[]) : null;
    if (!rawSeats || rawSeats.length < 1) return fail(req, "seats_required");
    if (rawSeats.length > MAX_SEATS) return fail(req, "too_many_seats");

    // Normalised here so the RPC receives exactly the keys it reads and nothing
    // a caller invented can reach the database.
    const seats = rawSeats.map((s) => {
      const tariff = (s?.tariff ?? "full").toString().trim().toLowerCase();
      return {
        badge: credential(s?.badge),
        holder: (s?.holder ?? "").toString().trim().slice(0, 60) || null,
        wheelchair: s?.wheelchair === true,
        tariff: TARIFFS.has(tariff) ? tariff : "full",
      };
    });

    // Give back anything abandoned on a Stripe page before counting, so a busy
    // screening does not look full because of checkouts nobody finished.
    await db().rpc("ticket_expire_holds");

    let label: string;
    let fullCents: number;
    let reducedCents: number;

    if (day) {
      const { data: fd, error: fdErr } = await db()
        .from("festival_days")
        .select("day, is_on_sale, price_cents, price_reduced_cents")
        .eq("day", day)
        .maybeSingle();

      if (fdErr) return fail(req, "server_error", 500, fdErr.message);
      if (!fd || !fd.is_on_sale) return fail(req, "unknown_day", 404);

      label = `Merge Film Festival 2026 — ${day}`;
      fullCents = fd.price_cents;
      reducedCents = fd.price_reduced_cents;
    } else {
      const { data: show, error: showErr } = await db()
        .from("screening_availability")
        .select("code, title, venue, starts_at, price_cents, price_reduced_cents")
        .eq("code", screening)
        .maybeSingle();

      if (showErr) return fail(req, "server_error", 500, showErr.message);
      if (!show) return fail(req, "unknown_screening", 404);

      label = `Merge Film Festival 2026 — ${show.title}`;
      fullCents = show.price_cents;
      reducedCents = show.price_reduced_cents;
    }

    const { data: result, error } = day
      ? await db().rpc("ticket_day_pass_reserve", {
        p_day: day,
        p_first_name: firstName,
        p_last_name: lastName,
        p_email: email,
        p_seats: seats,
        p_locale: locale,
        p_hold_mins: HOLD_MINUTES,
        p_access_code: invite,
      })
      : await db().rpc("ticket_reserve", {
        p_screening: screening,
        p_first_name: firstName,
        p_last_name: lastName,
        p_email: email,
        p_seats: seats,
        p_locale: locale,
        p_hold_mins: HOLD_MINUTES,
        p_access_code: invite,
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
      // A mail outage must not make a valid reservation appear to have failed.
      try { await emailTickets(orderId); } catch { console.error("ticket email delivery failed"); }
      return json(req, {
        ok: true,
        outcome: "reserved",
        order_id: orderId,
        codes: result.codes,
      });
    }

    // --- straight to checkout ------------------------------------------------
    try {
      const session = await createTicketCheckoutSession({
        orderId,
        lines: checkoutLines(label, seats, fullCents, reducedCents),
        locale,
        email,
        holdMinutes: CHECKOUT_MINUTES,
      });

      const { error: saveError } = await db()
        .from("ticket_orders")
        .update({ stripe_session_id: session.id })
        .eq("id", orderId);

      if (saveError) throw new Error("checkout persistence failed");
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
}, {"scope":"ticket-reserve","methods":["POST"],"limit":8,"globalLimit":120}));
