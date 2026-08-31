// Just enough Stripe for one-off Checkout payments, over plain fetch.
//
// The SDK is heavy for an edge function and we need exactly two calls, so the
// REST API it is. Card, TWINT and the wallets all come from whatever is enabled
// in the Stripe dashboard: we deliberately do not pin payment_method_types, so
// turning TWINT on there is enough to have it appear at checkout.

import { env } from "./env.ts";
import { passName, type Locale } from "./templates.ts";

function form(params: Record<string, string | number | undefined>): string {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") body.set(k, String(v));
  }
  return body.toString();
}

// Stripe speaks a handful of locales; ours all map cleanly.
const CHECKOUT_LOCALE: Record<Locale, string> = { it: "it", en: "en", fr: "fr", de: "de" };

export async function createCheckoutSession(o: {
  passId: string;
  type: string;
  locale: Locale;
  email: string;
  amountCents: number;
}): Promise<{ id: string; url: string }> {
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.stripeSecretKey()}`,
      "content-type": "application/x-www-form-urlencoded",
      // Two people double-clicking the button get one session, not two.
      "idempotency-key": `pass-${o.passId}`,
    },
    body: form({
      mode: "payment",
      "line_items[0][quantity]": 1,
      "line_items[0][price_data][currency]": "chf",
      "line_items[0][price_data][unit_amount]": o.amountCents,
      "line_items[0][price_data][product_data][name]":
        `Merge Film Festival 2026 — ${passName(o.type, o.locale)}`,
      customer_email: o.email,
      client_reference_id: o.passId,
      "metadata[pass_id]": o.passId,
      "metadata[pass_type]": o.type,
      locale: CHECKOUT_LOCALE[o.locale],
      // Checkout expires on its own, which frees the seat it was holding on a
      // limited access code (see the sweep in pass-submit).
      expires_at: Math.floor(Date.now() / 1000) + 60 * 60 * 23,
      success_url: `${env.siteUrl}/passes/success.html?p=${o.passId}`,
      cancel_url: `${env.siteUrl}/passes/?cancelled=1`,
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe checkout: ${data?.error?.message ?? res.status}`);
  return { id: data.id as string, url: data.url as string };
}

// Verifies the `Stripe-Signature` header. Without this anyone who finds the
// webhook URL could mark any pass as paid, so it is not optional.
export async function verifyWebhook(payload: string, header: string | null): Promise<boolean> {
  if (!header) return false;

  const parts = Object.fromEntries(
    header.split(",").map((p) => p.split("=", 2) as [string, string]),
  );
  const timestamp = parts.t;
  const signature = parts.v1;
  if (!timestamp || !signature) return false;

  // Reject anything older than five minutes so a captured request cannot be
  // replayed later.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.stripeWebhookSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return timingSafeEqual(expected, signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
