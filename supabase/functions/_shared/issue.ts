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

  const { data: result, error } = await db()
    .rpc("pass_issue", { p_pass: pass.id });
  if (error || !result?.code) throw new Error(`badge issue: ${error?.message ?? "no code"}`);
  const code = result.code as string;
  if (result.already) return code;

  await logEvent(pass.id, "issued", code, actor);

  await emailIssued(pass, code);

  return code;
}

// The badge email on its own: sent by issuePass, and sent again by hand
// (`ticket-mail`, action "badges") when that first attempt failed — a mail
// outage, an exhausted quota. The outcome goes in the audit trail either way,
// which is also how the retry finds who is still waiting.
export async function emailIssued(
  pass: Pick<Pass, "id" | "email" | "first_name" | "type" | "locale">,
  code: string,
): Promise<boolean> {
  if (!pass.email) return false;
  const mail = issuedEmail({
    name: pass.first_name,
    type: pass.type,
    locale: asLocale(pass.locale),
    badgeCode: code,
    badgeUrl: badgeUrl(code),
  });
  try {
    await sendMail({ to: pass.email, subject: mail.subject, html: mail.html });
    await logEvent(pass.id, "email", `issued -> ${pass.email}`);
    return true;
  } catch (e) {
    // The pass is valid whether or not the mail went out; the dashboard shows
    // this failure so somebody can resend by hand.
    await logEvent(pass.id, "error", `issued email failed: ${String(e)}`);
    return false;
  }
}

