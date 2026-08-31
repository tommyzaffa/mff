// GET  /functions/v1/pass-review?t=<token>   the request, as JSON
// POST /functions/v1/pass-review             approve or reject
//
// This backs the link in the email that lands in the festival inbox for press
// and industry requests. The token is the only credential, which is why the
// decision is taken on POST: mail clients and link scanners follow GETs, and
// none of them should be able to approve an accreditation by prefetching a link.
//
// The page itself lives at /passes/review.html on the site, not here: Supabase's
// gateway rewrites any text/html coming out of an edge function to text/plain
// with a sandbox CSP (it will not let *.supabase.co serve pages), so a function
// can only ever answer with data.

import { db, kind, logEvent, signedFileUrl, type Pass } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { json, preflight } from "../_shared/http.ts";
import { issuePass } from "../_shared/issue.ts";
import { sendMail } from "../_shared/mail.ts";
import { approvedEmail, asLocale, passName, rejectedEmail } from "../_shared/templates.ts";
import { createCheckoutSession } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const pass = await byToken(url.searchParams.get("t") ?? "");
      if (!pass) return json(req, { ok: false, error: "not_found" }, 404);
      if (pass.status !== "pending_review") {
        return json(req, { ok: false, error: "already", status: pass.status });
      }
      return json(req, { ok: true, request: await details(pass) });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({})) as Record<string, unknown>;
      const token = String(body.token ?? "");
      const action = String(body.action ?? "");
      const note = String(body.note ?? "").trim();

      const pass = await byToken(token);
      if (!pass) return json(req, { ok: false, error: "not_found" }, 404);
      if (pass.status !== "pending_review") {
        return json(req, { ok: false, error: "already", status: pass.status });
      }
      if (action !== "approve" && action !== "reject") {
        return json(req, { ok: false, error: "unknown_action" }, 400);
      }

      return json(req, action === "approve" ? await approve(pass, note) : await reject(pass, note));
    }

    return json(req, { ok: false, error: "method_not_allowed" }, 405);
  } catch (e) {
    console.error("pass-review", e);
    return json(req, { ok: false, error: "server_error" }, 500);
  }
});

async function byToken(token: string): Promise<Pass | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const { data } = await db().from("passes").select("*").eq("review_token", token).maybeSingle();
  return (data as Pass) ?? null;
}

async function details(pass: Pass) {
  const k = await kind(pass.type);
  return {
    name: `${pass.first_name} ${pass.last_name}`,
    email: pass.email ?? "",
    pass: passName(pass.type, "it"),
    orgLabel: pass.type === "press" ? "Testata" : "Casa di produzione",
    org: pass.org ?? "",
    amountCents: pass.amount_cents || k?.price_cents || 0,
    createdAt: pass.created_at,
    photoUrl: await signedFileUrl("pass-photos", pass.photo_path, 3600),
    proofUrl: await signedFileUrl("pass-docs", pass.proof_path, 3600),
  };
}

// --- decisions --------------------------------------------------------------

async function approve(pass: Pass, note: string) {
  const k = await kind(pass.type);
  const locale = asLocale(pass.locale);
  const amount = pass.amount_cents || k?.price_cents || 0;
  const name = `${pass.first_name} ${pass.last_name}`;

  // An approved request that owes nothing is already done; otherwise the
  // applicant gets a checkout link and the pass waits for the webhook.
  if (amount === 0) {
    await db().from("passes").update({
      reviewed_at: new Date().toISOString(),
      review_note: note || null,
    }).eq("id", pass.id);
    await logEvent(pass.id, "approved", note || null, "email-link");
    const code = await issuePass({ ...pass, status: "awaiting_payment" });
    return { ok: true as const, result: "issued" as const, name, badge: code };
  }

  const session = await createCheckoutSession({
    passId: pass.id,
    type: pass.type,
    locale,
    email: pass.email ?? "",
    amountCents: amount,
  });

  await db().from("passes").update({
    status: "awaiting_payment",
    stripe_session_id: session.id,
    reviewed_at: new Date().toISOString(),
    review_note: note || null,
  }).eq("id", pass.id);

  await logEvent(pass.id, "approved", note || null, "email-link");

  const mail = approvedEmail({
    name: pass.first_name,
    type: pass.type,
    locale,
    payUrl: session.url,
    amountCents: amount,
  });
  await sendMail({ to: pass.email!, subject: mail.subject, html: mail.html });
  await logEvent(pass.id, "email", `approved -> ${pass.email}`);

  return { ok: true as const, result: "approved" as const, name, pass: passName(pass.type, "it") };
}

async function reject(pass: Pass, note: string) {
  await db().from("passes").update({
    status: "rejected",
    reviewed_at: new Date().toISOString(),
    review_note: note || null,
  }).eq("id", pass.id);

  await logEvent(pass.id, "rejected", note || null, "email-link");

  const mail = rejectedEmail({
    name: pass.first_name,
    type: pass.type,
    locale: asLocale(pass.locale),
    note,
    passesUrl: `${env.siteUrl}/passes/`,
  });
  await sendMail({ to: pass.email!, subject: mail.subject, html: mail.html });
  await logEvent(pass.id, "email", `rejected -> ${pass.email}`);

  return { ok: true as const, result: "rejected" as const, name: `${pass.first_name} ${pass.last_name}` };
}
