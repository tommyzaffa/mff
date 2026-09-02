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

export async function emailTickets(orderId: string): Promise<boolean> {
  const { data: order } = await db()
    .from("ticket_orders")
    .select("id, screening, first_name, last_name, email, locale, amount_cents")
    .eq("id", orderId)
    .maybeSingle();
  if (!order) return false;

  const [{ data: show }, { data: tickets }] = await Promise.all([
    db().from("screenings").select("title, venue, starts_at")
      .eq("code", order.screening).maybeSingle(),
    db().from("tickets").select("code, holder_name, badge_code")
      .eq("order_id", orderId).is("cancelled_at", null)
      .order("created_at", { ascending: true }),
  ]);
  if (!show || !tickets?.length) return false;

  const mail = ticketsEmail({
    name: order.first_name,
    locale: asLocale(order.locale),
    screeningTitle: show.title,
    startsAt: show.starts_at,
    venue: show.venue,
    amountCents: order.amount_cents,
    tickets: tickets.map((t) => ({
      code: t.code,
      holder: t.holder_name,
      badge: t.badge_code,
      url: `${env.siteUrl}/tickets/ticket.html?c=${encodeURIComponent(t.code)}`,
    })),
  });

  await sendMail({ to: order.email, subject: mail.subject, html: mail.html });
  return true;
}
