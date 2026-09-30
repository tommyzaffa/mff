// Sending an order's tickets out.
//
// Shared because three different functions have to do it: `ticket-reserve` when
// a party is wholly accredited and owes nothing, the Stripe webhook when a paid
// order finally goes through, and `ticket-mail` when the festival sends tickets
// for bookings that never went through the site. Each edge function is deployed
// on its own, so anything two of them use has to live here rather than be
// imported across.
//
// It reads the tickets back from the database instead of taking them as
// arguments, so there is exactly one description of what a ticket email contains.

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

export const ORDER_COLUMNS =
  "id, screening, day, first_name, last_name, email, locale, amount_cents, status, email_sent_at";

export type MailOrder = {
  id: string;
  screening: string | null;
  day: string | null;
  first_name: string;
  last_name: string;
  email: string;
  locale: string;
  amount_cents: number;
  status: string;
  email_sent_at: string | null;
};

export async function emailTickets(orderId: string): Promise<boolean> {
  const { data: order } = await db()
    .from("ticket_orders")
    .select(ORDER_COLUMNS)
    .eq("id", orderId)
    .maybeSingle();
  if (!order || order.status !== "issued") return false;
  if (order.email_sent_at) return true;

  return await emailTicketGroup([order as MailOrder], `ticket-issued/${order.id}`) > 0;
}

// Several orders, one message. They must share the recipient and the screening
// (or the day, for day passes): a school booked in batches of ten is still one
// teacher waiting for one list of seats, not four emails that each look like
// the whole booking. The first order speaks for the group — name and language.
//
// Returns how many tickets went out; 0 means there was nothing to send and
// nothing was marked. Throws if the mail provider refuses, before anything is
// marked, so the orders stay unsent and can be tried again.
export async function emailTicketGroup(orders: MailOrder[], idempotencyKey: string): Promise<number> {
  const lead = orders[0];
  if (!lead) return 0;
  const recipient = lead.email.toLowerCase();
  if (orders.some((o) =>
    o.status !== "issued" || o.email.toLowerCase() !== recipient ||
    o.screening !== lead.screening || o.day !== lead.day
  )) {
    throw new Error("a ticket email groups issued orders of one recipient and one event");
  }

  const ids = orders.map((o) => o.id);
  const locale = asLocale(lead.locale);
  const amountCents = orders.reduce((sum, o) => sum + o.amount_cents, 0);
  let mail: { subject: string; html: string };
  let count: number;

  // --- a day pass ----------------------------------------------------------
  // A pass reserves nothing, so there are no tickets to send: the email is the
  // code and the instruction to go and book with it.
  if (lead.day) {
    const { data: passes } = await db()
      .from("day_passes")
      .select("code, holder_name, tariff")
      .in("order_id", ids).is("cancelled_at", null)
      .order("created_at", { ascending: true });
    if (!passes?.length) return 0;

    // The day starts at its first screening, which is the hour the holder has
    // to plan around even though the pass admits to none of them yet.
    const { data: first } = await db()
      .from("screenings")
      .select("venue, starts_at")
      .eq("is_published", true).eq("is_ticketed", true)
      .gte("starts_at", `${lead.day}T00:00:00+02:00`)
      .lte("starts_at", `${lead.day}T23:59:59+02:00`)
      .order("starts_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    const dayLabel = new Date(`${lead.day}T00:00:00`).toLocaleDateString(locale, {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "Europe/Zurich",
    });

    count = passes.length;
    mail = ticketsEmail({
      name: lead.first_name,
      locale,
      screeningTitle: DAY_PASS_NAME[locale](dayLabel),
      startsAt: first?.starts_at ?? `${lead.day}T10:00:00+02:00`,
      venue: first?.venue ?? null,
      amountCents,
      dayPass: true,
      tickets: passes.map((p) => ({
        code: p.code,
        holder: p.holder_name,
        badge: null,
        tariff: p.tariff,
        url: `${env.siteUrl}/tickets/ticket.html?c=${encodeURIComponent(p.code)}`,
      })),
    });
  } else {
    // --- a single screening ------------------------------------------------
    const { data: rows } = await db()
      .from("tickets")
      .select("code, holder_name, badge_code, tariff, day_pass_code, screening")
      .in("order_id", ids).is("cancelled_at", null)
      .order("created_at", { ascending: true });
    if (!rows?.length) return 0;

    const { data: show } = await db()
      .from("screenings").select("title, venue, starts_at")
      .eq("code", lead.screening).maybeSingle();
    if (!show) return 0;

    count = rows.length;
    mail = ticketsEmail({
      name: lead.first_name,
      locale,
      screeningTitle: show.title,
      startsAt: show.starts_at,
      venue: show.venue,
      amountCents,
      tickets: rows.map((t) => ({
        code: t.code,
        holder: t.holder_name,
        badge: t.badge_code,
        dayPass: t.day_pass_code,
        tariff: t.tariff,
        url: `${env.siteUrl}/tickets/ticket.html?c=${encodeURIComponent(t.code)}`,
      })),
    });
  }

  await sendMail({ to: lead.email, subject: mail.subject, html: mail.html, idempotencyKey });
  const { error: sentError } = await db().from("ticket_orders")
    .update({ email_sent_at: new Date().toISOString() }).in("id", ids);
  if (sentError) throw new Error("receipt delivery persistence failed");
  return count;
}
