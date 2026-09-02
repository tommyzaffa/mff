// Every secret the pass functions need, read once and validated loudly.
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform. The
// rest are set with `supabase secrets set` — see supabase/README.md.

function need(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function optional(name: string, fallback: string): string {
  return Deno.env.get(name) || fallback;
}

export const env = {
  supabaseUrl: need("SUPABASE_URL"),
  serviceRoleKey: need("SUPABASE_SERVICE_ROLE_KEY"),

  // Public site. Used to build the badge links that go out in emails, and as the
  // return address for Stripe checkout.
  siteUrl: optional("SITE_URL", "https://mergefestival.ch").replace(/\/+$/, ""),

  stripeSecretKey: () => need("STRIPE_SECRET_KEY"),
  stripeWebhookSecret: () => need("STRIPE_WEBHOOK_SECRET"),

  resendApiKey: () => need("RESEND_API_KEY"),
  mailFrom: optional("MAIL_FROM", "Merge Film Festival <accreditations@mergefestival.ch>"),
  // Where the press/industry approval requests land. Deliberately a different
  // mailbox from MAIL_FROM: a message sent from and to the same address looks
  // like spoofing to the recipient's own filter.
  mailReviewTo: optional("MAIL_REVIEW_TO", "info@mergefestival.ch"),

  // The one shared password the Lux box office types into /door/. It guards a
  // page that shows seat counts and no personal data, and it is typed by people
  // on a shift rather than held by one person, so a passphrase everyone can be
  // told over the counter is the right shape here — not an account each.
  doorPassword: () => need("DOOR_PASSWORD"),

  // Google Wallet (optional — the save button hides itself when unset).
  googleIssuerId: () => Deno.env.get("GOOGLE_WALLET_ISSUER_ID") || "",
  googleServiceAccount: () => Deno.env.get("GOOGLE_WALLET_SERVICE_ACCOUNT") || "",

  // Apple Wallet (optional, needs a paid Apple Developer account).
  appleTeamId: () => Deno.env.get("APPLE_TEAM_ID") || "",
  applePassTypeId: () => Deno.env.get("APPLE_PASS_TYPE_ID") || "",
  applePassCertificate: () => Deno.env.get("APPLE_PASS_CERTIFICATE") || "",
  applePassKey: () => Deno.env.get("APPLE_PASS_KEY") || "",
  appleWwdrCertificate: () => Deno.env.get("APPLE_WWDR_CERTIFICATE") || "",
};

export const allowedOrigins = [
  env.siteUrl,
  "https://mergefestival.ch",
  "https://www.mergefestival.ch",
  "http://localhost:4321",
  "http://127.0.0.1:4321",
];
