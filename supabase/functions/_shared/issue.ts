// Handing a pass to its owner.
//
// Three different paths end here — a free pass with a code, a paid pass whose
// Stripe webhook arrived, and an approved press request that was then paid — so
// the badge number and the email live in one place rather than three.

import { db, logEvent, type Pass } from "./db.ts";
import { env } from "./env.ts";
import { sendMail } from "./mail.ts";
import { asLocale, issuedEmail } from "./templates.ts";

export function badgeUrl(code: string): string {
  return `${env.siteUrl}/badge/?c=${encodeURIComponent(code)}`;
}

// Idempotent on purpose: Stripe retries webhooks, and a pass that is already
// issued must not get a second badge number or a second email.
export async function issuePass(pass: Pass, actor?: string): Promise<string> {
  if (pass.status === "issued" && pass.badge_code) return pass.badge_code;

  const { data: code, error } = await db()
    .rpc("pass_claim_badge_code", { p_pass: pass.id });
  if (error || !code) throw new Error(`badge code: ${error?.message ?? "none available"}`);

  await db()
    .from("passes")
    .update({ status: "issued", issued_at: new Date().toISOString() })
    .eq("id", pass.id);

  await logEvent(pass.id, "issued", code, actor);

  if (pass.email) {
    const locale = asLocale(pass.locale);
    const mail = issuedEmail({
      name: pass.first_name,
      type: pass.type,
      locale,
      badgeCode: code,
      badgeUrl: badgeUrl(code),
    });
    try {
      await sendMail({ to: pass.email, subject: mail.subject, html: mail.html });
      await logEvent(pass.id, "email", `issued -> ${pass.email}`);
    } catch (e) {
      // The pass is valid whether or not the mail went out; the dashboard shows
      // this failure so somebody can resend by hand.
      await logEvent(pass.id, "error", `issued email failed: ${String(e)}`);
    }
  }

  return code;
}
