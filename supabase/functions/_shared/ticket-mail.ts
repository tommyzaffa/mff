// Sending an order's tickets out.
//
// Shared because two different functions have to do it: `ticket-reserve` when a
// party is wholly accredited and owes nothing, and the Stripe webhook when a
// paid order finally goes through. Each edge function is deployed on its own, so
// anything two of them use has to live here rather than be imported across.
//
// It reads the order back from the database instead of taking it as arguments,
// so there is exactly one description of what a ticket email contains.

import { db } from "./db.ts";
import { env } from "./env.ts";
import { sendMail } from "./mail.ts";
import { asLocale, ticketsEmail } from "./templates.ts";

// What the day pass is called in the email. Built from the date rather than
// stored, so there is nothing to keep in step with the schedule.
const DAY_PASS_NAME: Record<string, (d: string) => string> = {
  it: (d) => `Giornaliera · ${d}`,
  en: (d) => `Day pass · ${d}`,
  fr: (d) => `Pass journée · ${d}`,
  de: (d) => `Tagespass · ${d}`,
};

export async function emailTickets(orderId: string): Promise<boolean> {
  const { data: order } = await db()
    .from("ticket_orders")
    .select("id, screening, day, first_name, last_name, email, locale, amount_cents, status, email_sent_at")
    .eq("id", orderId)
    .maybeSingle();
  if (!order || order.status !== "issued") return false;
  if (order.email_sent_at) return true;

  const locale = asLocale(order.locale);

  const { data: rows } = await db()
    .from("tickets")
    .select("code, holder_name, badge_code, tariff, day_pass_code, screening")
    .eq("order_id", orderId).is("cancelled_at", null)
    .order("created_at", { ascending: true });
  if (!rows?.length) return false;

  // --- a day pass ----------------------------------------------------------
  // One row per screening per person, but one code per person. Collapse to the
  // codes, or a two-film day would send the same pass twice.
  if (order.day) {
    const seen = new Set<string>();
    const passes = rows.filter((r) => {
      if (!r.day_pass_code || seen.has(r.day_pass_code)) return false;
      seen.add(r.day_pass_code);
      return true;
    });
    if (!passes.length) return false;

    // The day starts at its first screening, which is what the holder needs to
    // know and is already in the rows we have.
    const { data: first } = await db()
      .from("screenings")
      .select("venue, starts_at")
      .in("code", rows.map((r) => r.screening))
      .order("starts_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    const dayLabel = new Date(`${order.day}T00:00:00`).toLocaleDateString(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "Europe/Zurich",
    });

    const mail = ticketsEmail({
      name: order.first_name,
      locale,
      screeningTitle: DAY_PASS_NAME[locale](dayLabel),
      startsAt: first?.starts_at ?? `${order.day}T10:00:00+02:00`,
      venue: first?.venue ?? null,
      amountCents: order.amount_cents,
      dayPass: true,
      tickets: passes.map((t) => ({
        code: t.day_pass_code as string,
        holder: t.holder_name,
        badge: null,
        tariff: t.tariff,
        url: `${env.siteUrl}/tickets/ticket.html?c=${
          encodeURIComponent(t.day_pass_code as string)
        }`,
      })),
    });

    await sendMail({ to: order.email, subject: mail.subject, html: mail.html, idempotencyKey: `ticket-issued/${order.id}` });
    const { error: sentError } = await db().from("ticket_orders").update({ email_sent_at: new Date().toISOString() }).eq("id", order.id);
    if (sentError) throw new Error("receipt delivery persistence failed");
    return true;
  }

  // --- a single screening --------------------------------------------------
  const { data: show } = await db()
    .from("screenings").select("title, venue, starts_at")
    .eq("code", order.screening).maybeSingle();
  if (!show) return false;

  const mail = ticketsEmail({
    name: order.first_name,
    locale,
    screeningTitle: show.title,
    startsAt: show.starts_at,
    venue: show.venue,
    amountCents: order.amount_cents,
    tickets: rows.map((t) => ({
      code: t.code,
      holder: t.holder_name,
      badge: t.badge_code,
      tariff: t.tariff,
      url: `${env.siteUrl}/tickets/ticket.html?c=${encodeURIComponent(t.code)}`,
    })),
  });

  await sendMail({ to: order.email, subject: mail.subject, html: mail.html, idempotencyKey: `ticket-issued/${order.id}` });
    const { error: sentError } = await db().from("ticket_orders").update({ email_sent_at: new Date().toISOString() }).eq("id", order.id);
    if (sentError) throw new Error("receipt delivery persistence failed");
  return true;
}
