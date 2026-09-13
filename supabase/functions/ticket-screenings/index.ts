import { secured } from "../_shared/security.ts";
// GET /functions/v1/ticket-screenings
//
// The programme as the public may see it: what is on, when, what it costs and
// how many seats are left. Deliberately its own endpoint rather than letting the
// browser read the table with the anon key, because `screening_availability`
// joins the orders — and those carry names and email addresses.
//
// It also answers with the days that are sold as a pass. A day pass takes one
// seat in every screening of that day that is still on sale, so what is left of
// it is the smallest of those — computed here rather than stored, because it
// changes with every booking and with the clock.
//
// Every read first sweeps expired holds, so seats abandoned on a Stripe page
// come back into the count without a cron job to forget to set up.

import { db } from "../_shared/db.ts";
import { fail, json, preflight } from "../_shared/http.ts";

// A screening's calendar day in festival time, which is the only sense in which
// a 21:15 show and a 10:00 one belong to the same pass.
function zurichDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Europe/Zurich" });
}

Deno.serve(secured(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "GET") return fail(req, "method_not_allowed", 405);

  try {
    await db().rpc("ticket_expire_holds");

    const one = new URL(req.url).searchParams.get("s");

    const { data, error } = await db()
      .from("screening_availability")
      .select(
        "code, title, section, venue, starts_at, price_cents, price_reduced_cents, capacity, seats_left, wheelchair_left, sales_open, sales_close_at, is_ticketed",
      )
      .eq("is_published", true)
      .order("starts_at", { ascending: true });
    if (error) return fail(req, "server_error", 500, error.message);

    const screenings = data ?? [];

    const { data: fdays, error: fdErr } = await db()
      .from("festival_days")
      .select("day, price_cents, price_reduced_cents")
      .eq("is_on_sale", true)
      .order("day", { ascending: true });
    if (fdErr) return fail(req, "server_error", 500, fdErr.message);

    const days = (fdays ?? []).map((d) => {
      const open = screenings.filter((s) =>
        s.is_ticketed && s.sales_open && zurichDay(s.starts_at) === d.day
      );
      return {
        ...d,
        screenings: open.map((s) => s.code),
        // No screening of that day is still on sale, so there is no pass left
        // to sell either — the whole day has moved to the box office.
        seats_left: open.length ? Math.min(...open.map((s) => s.seats_left)) : 0,
        sales_open: open.length > 0,
      };
    });

    return json(req, {
      ok: true,
      screenings: one ? screenings.filter((s) => s.code === one) : screenings,
      days,
    });
  } catch (e) {
    console.error("ticket-screenings", e);
    return fail(req, "server_error", 500, String(e));
  }
}, {"scope":"ticket-screenings","methods":["GET"],"limit":120,"globalLimit":1500}));
