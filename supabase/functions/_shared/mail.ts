// Transactional email through Resend.
//
// Resend was picked over SES/Brevo for one reason: it is a single HTTPS call
// with no SDK, which is all an edge function can comfortably do. The free tier
// (3'000 messages a month) covers a festival this size; see supabase/README.md
// if that ever needs revisiting.

import { env } from "./env.ts";

const VIOLET = "#4B2E83";
const VIOLET_DEEP = "#2E1B54";
const CREAM = "#F3F2EF";
const INK = "#0F0F12";
const MUTED = "#6b6b75";

// The festival mark, served from the live site. Absolute and https, because a
// mail client has no base URL to resolve against.
const MARK = "https://mergefestival.ch/assets/img/apple-touch-icon.png";
const SITE = "https://mergefestival.ch";

// The footer is the part that tells a filter — and a reader — that this is a
// real organisation writing for a reason, so it is worth translating properly.
const FOOTER: Record<string, { dates: string; why: string; write: string }> = {
  it: {
    dates: "1–4 ottobre 2026 · Lugano",
    why: "Ricevi questa email perché hai richiesto un accredito per il Merge Film Festival.",
    write: "Scrivici",
  },
  en: {
    dates: "1–4 October 2026 · Lugano",
    why: "You are receiving this email because you requested accreditation for the Merge Film Festival.",
    write: "Write to us",
  },
  fr: {
    dates: "1–4 octobre 2026 · Lugano",
    why: "Vous recevez cet e-mail car vous avez demandé une accréditation pour le Merge Film Festival.",
    write: "Écrivez-nous",
  },
  de: {
    dates: "1.–4. Oktober 2026 · Lugano",
    why: "Du erhältst diese E-Mail, weil du eine Akkreditierung für das Merge Film Festival angefragt hast.",
    write: "Schreib uns",
  },
};

type SendArgs = {
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string;
};

export async function sendMail({ to, subject, html, replyTo }: SendArgs): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.resendApiKey()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.mailFrom,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      // A plain-text alternative alongside the HTML. Nobody reads it, but a
      // message that has no text part at all is a spam signal in its own right,
      // and iCloud in particular weighs it heavily against a young domain.
      text: toText(html),
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }
}

// Flatten the HTML we just built into something readable. The layout is ours,
// so this does not need to be a real parser: drop the hidden preheader, keep
// link targets next to their label, and collapse whatever is left.
function toText(html: string): string {
  return html
    .replace(/<span style="display:none[\s\S]*?<\/span>/gi, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    // Parentheses, not angle brackets: the tag-stripping pass below would eat
    // an <https://…> as if it were markup.
    .replace(/<a[^>]+href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ( $1 )")
    .replace(/<\/(p|tr|div|h[1-6])>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Tables and inline styles, because that is still the only thing every mail
// client agrees on.
export function layout(opts: {
  preheader: string;
  heading: string;
  body: string;
  cta?: { label: string; href: string };
  footnote?: string;
  locale?: string;
  // Overrides the "why you are getting this" line. The default speaks to an
  // applicant; the internal review email goes to the office instead.
  why?: string;
}): string {
  const f = FOOTER[opts.locale || "it"] || FOOTER.it;

  const cta = opts.cta
    ? `<tr><td style="padding:6px 0 2px">
         <a href="${esc(opts.cta.href)}" style="display:inline-block;background:${VIOLET};color:${CREAM};
            text-decoration:none;padding:15px 30px;border-radius:16px;font-weight:600;font-size:15px">
           ${esc(opts.cta.label)}
         </a></td></tr>
       <!-- The bare URL under the button: some clients strip or fail to render
            the anchor, and a payment link that cannot be reached is a support
            ticket. -->
       <tr><td style="padding:12px 0 0;font-size:11.5px;line-height:1.5;color:#9a9aa2;word-break:break-all">
         ${esc(opts.cta.href)}
       </td></tr>`
    : "";

  const foot = opts.footnote
    ? `<tr><td style="padding-top:20px"><div style="height:1px;background:#eceae5;font-size:0;line-height:0">&nbsp;</div></td></tr>
       <tr><td style="padding-top:16px;font-size:12.5px;line-height:1.65;color:${MUTED}">${opts.footnote}</td></tr>`
    : "";

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light only"></head>
<body style="margin:0;padding:0;background:${CREAM};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${INK}">
<span style="display:none;font-size:1px;color:${CREAM};max-height:0;overflow:hidden">${esc(opts.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM};padding:34px 16px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:22px;overflow:hidden;box-shadow:0 2px 14px rgba(46,27,84,.08)">

      <!-- Masthead: the same mark that is on the site and on the home screen,
           so the message is recognisable before a word of it is read. -->
      <tr><td style="background:${VIOLET_DEEP};padding:24px 30px">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="46" style="padding-right:14px">
            <img src="${MARK}" width="46" height="46" alt="Merge Film Festival"
                 style="display:block;width:46px;height:46px;border-radius:12px">
          </td>
          <td style="vertical-align:middle">
            <div style="color:${CREAM};font-size:13px;letter-spacing:.16em;text-transform:uppercase;font-weight:600">Merge Film Festival</div>
            <div style="color:#b9aed4;font-size:12.5px;padding-top:4px">${esc(f.dates)}</div>
          </td>
        </tr></table>
      </td></tr>
      <!-- Hairline in the festival violet, so the dark masthead does not sit
           straight on white. -->
      <tr><td style="height:3px;background:${VIOLET};font-size:0;line-height:0">&nbsp;</td></tr>

      <tr><td style="padding:32px 30px 30px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="font-size:24px;line-height:1.25;font-weight:700;padding-bottom:14px">${esc(opts.heading)}</td></tr>
          <tr><td style="font-size:15px;line-height:1.65;color:#2b2b33;padding-bottom:22px">${opts.body}</td></tr>
          ${cta}
          ${foot}
        </table>
      </td></tr>

      <tr><td style="padding:20px 30px 24px;border-top:1px solid #e9e7e2;background:#faf9f7">
        <div style="font-size:12.5px;line-height:1.6;color:#5a5a63">
          <strong style="color:${INK}">Merge Film Festival</strong> · ${esc(f.dates)}<br>
          <a href="${SITE}" style="color:${VIOLET};text-decoration:none">mergefestival.ch</a>
          &nbsp;·&nbsp;
          <a href="mailto:info@mergefestival.ch" style="color:${VIOLET};text-decoration:none">${esc(f.write)}</a>
        </div>
        <div style="font-size:11.5px;line-height:1.6;color:#9a9aa2;padding-top:10px">${esc(opts.why || f.why)}</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}
