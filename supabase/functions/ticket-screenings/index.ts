// GET /functions/v1/ticket-screenings
//
// The programme as the public may see it: what is on, when, what it costs and
// how many seats are left. Deliberately its own endpoint rather than letting the
// browser read the table with the anon key, because `screening_availability`
// joins the orders — and those carry names and email addresses.
//
// Every read first sweeps expired holds, so seats abandoned on a Stripe page
// come back into the count without a cron job to forget to set up.

import { db } from "../_shared/db.ts";
import { fail, json, preflight } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "GET") return fail(req, "method_not_allowed", 405);

  try {
    await db().rpc("ticket_expire_holds");

    const one = new URL(req.url).searchParams.get("s");

    let q = db()
      .from("screening_availability")
      .select(
        "code, title, section, venue, starts_at, price_cents, capacity, " +
          "seats_left, wheelchair_left, sales_open, sales_close_at, is_ticketed",
      )
      .eq("is_published", true)
      .order("starts_at", { ascending: true });

    if (one) q = q.eq("code", one);

    const { data, error } = await q;
    if (error) return fail(req, "server_error", 500, error.message);

    return json(req, { ok: true, screenings: data ?? [] });
  } catch (e) {
    console.error("ticket-screenings", e);
    return fail(req, "server_error", 500, String(e));
  }
});
