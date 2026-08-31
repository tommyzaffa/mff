// POST /functions/v1/pass-submit
//
// The single entry point for every accreditation request. It takes the form as
// multipart (the photo comes with it), works out which of the three outcomes
// applies, and tells the page what to do next:
//
//   issued   — free pass, or a paid one waived by an access code: badge is ready
//   checkout — guest passes: here is the Stripe URL
//   review   — press and industry: we have to approve first
//
// It also answers a small JSON probe (`{"action":"check_code"}`) so the form can
// tell someone their code is good before they fill in the rest.

import { db, kind, logEvent, signedFileUrl, type Pass } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { fail, json, preflight } from "../_shared/http.ts";
import { issuePass } from "../_shared/issue.ts";
import { sendMail } from "../_shared/mail.ts";
import { asLocale, receivedEmail, reviewRequestEmail } from "../_shared/templates.ts";
import { createCheckoutSession } from "../_shared/stripe.ts";

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const PROOF_TYPES = [...PHOTO_TYPES, "application/pdf"];
const MAX_PHOTO = 6 * 1024 * 1024;
const MAX_PROOF = 10 * 1024 * 1024;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "POST") return fail(req, "method_not_allowed", 405);

  try {
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = await req.json();
      if (body?.action === "check_code") {
        return json(req, await checkCode(String(body.code ?? ""), String(body.type ?? "")));
      }
      return fail(req, "bad_request");
    }

    return await submit(req);
  } catch (e) {
    console.error("pass-submit", e);
    return fail(req, "server_error", 500, String(e));
  }
});

// --- code probe -------------------------------------------------------------

// Read-only: it never burns a use. The real check happens under a row lock when
// the pass is actually created.
async function checkCode(raw: string, type: string) {
  const code = raw.trim().toUpperCase();
  if (!code) return { ok: false, error: "code_required" };

  const { data } = await db()
    .from("pass_access_codes")
    .select("code, label, allowed_types, max_uses, uses, expires_at, is_active")
    .eq("code", code)
    .maybeSingle();

  if (!data || !data.is_active) return { ok: false, error: "code_invalid" };
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return { ok: false, error: "code_expired" };
  }
  if (data.max_uses !== null && data.uses >= data.max_uses) {
    return { ok: false, error: "code_used" };
  }
  if (type && !(data.allowed_types as string[]).includes(type)) {
    return { ok: false, error: "code_wrong_type", types: data.allowed_types };
  }

  return { ok: true, label: data.label, types: data.allowed_types };
}

// --- the form ---------------------------------------------------------------

async function submit(req: Request): Promise<Response> {
  const form = await req.formData();
  const str = (k: string) => String(form.get(k) ?? "").trim();

  const type = str("type");
  const k = await kind(type);
  if (!k) return fail(req, "unknown_type");

  const firstName = str("first_name");
  const lastName = str("last_name");
  const email = str("email").toLowerCase();
  const org = str("org");
  const locale = asLocale(str("locale"));
  const accessCode = str("access_code").toUpperCase();

  if (!firstName || !lastName) return fail(req, "name_required");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) return fail(req, "email_invalid");
  if (k.needs_org && !org) return fail(req, "org_required");

  // The four internal passes cannot be applied for: you need a code we gave out.
  if (k.code_only && !accessCode) return fail(req, "code_required");

  // Fail early on an obviously bad code so nobody uploads a photo for nothing.
  if (accessCode) {
    const probe = await checkCode(accessCode, type);
    if (!probe.ok) return fail(req, probe.error as string);
  }

  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) return fail(req, "photo_required");
  if (!PHOTO_TYPES.includes(photo.type)) return fail(req, "photo_type");
  if (photo.size > MAX_PHOTO) return fail(req, "photo_too_big");

  // The student fare is the only thing that needs a document, and only when it
  // is actually being paid for — a code that waives the fee waives the proof too.
  const proof = form.get("proof");
  const proofNeeded = k.needs_proof && !accessCode;
  if (proofNeeded && (!(proof instanceof File) || proof.size === 0)) {
    return fail(req, "proof_required");
  }
  if (proof instanceof File && proof.size > 0) {
    if (!PROOF_TYPES.includes(proof.type)) return fail(req, "proof_type");
    if (proof.size > MAX_PROOF) return fail(req, "proof_too_big");
  }

  // Generated here so the storage paths can be built before the row exists.
  const passId = crypto.randomUUID();

  const photoPath = `${passId}/photo.${ext(photo.type)}`;
  const up1 = await db().storage.from("pass-photos").upload(photoPath, photo, {
    contentType: photo.type,
    upsert: true,
  });
  if (up1.error) return fail(req, "upload_failed", 500, up1.error.message);

  let proofPath: string | null = null;
  if (proof instanceof File && proof.size > 0) {
    proofPath = `${passId}/proof.${ext(proof.type)}`;
    const up2 = await db().storage.from("pass-docs").upload(proofPath, proof, {
      contentType: proof.type,
      upsert: true,
    });
    if (up2.error) return fail(req, "upload_failed", 500, up2.error.message);
  }

  const waived = accessCode.length > 0;
  const amount = waived ? 0 : k.price_cents;

  const { data: inserted, error } = await db()
    .from("passes")
    .insert({
      id: passId,
      type,
      status: "draft",
      first_name: firstName,
      last_name: lastName,
      email,
      org: org || null,
      photo_path: photoPath,
      proof_path: proofPath,
      access_code: waived ? accessCode : null,
      amount_cents: amount,
      locale,
    })
    .select("*")
    .single();

  if (error) {
    await cleanupFiles(photoPath, proofPath);
    // 23505 is the unique index that allows one live pass per email per type.
    if (error.code === "23505") return fail(req, "duplicate", 409);
    return fail(req, "server_error", 500, error.message);
  }

  const pass = inserted as Pass;

  // Now the authoritative check. Between the probe above and here somebody else
  // may have taken the last use of a limited code, so this is the one that counts.
  if (waived) {
    const { data: consumed } = await db()
      .rpc("pass_consume_access_code", { p_code: accessCode, p_type: type });
    if (!consumed) {
      await db().from("passes").delete().eq("id", passId);
      await cleanupFiles(photoPath, proofPath);
      return fail(req, "code_used", 409);
    }
  }

  await logEvent(passId, "submitted", waived ? `code ${accessCode}` : `${amount} cents`);

  // --- outcome 1: nothing to pay -------------------------------------------
  if (amount === 0) {
    const code = await issuePass(pass);
    return json(req, { ok: true, outcome: "issued", badge_code: code, badge_url: badge(code) });
  }

  // --- outcome 2: we have to approve first ---------------------------------
  if (k.needs_review) {
    await db().from("passes").update({ status: "pending_review" }).eq("id", passId);
    await logEvent(passId, "submitted", "awaiting review");

    const photoUrl = await signedFileUrl("pass-photos", photoPath, 60 * 60 * 24 * 7);
    const office = reviewRequestEmail({
      name: `${firstName} ${lastName}`,
      email,
      type,
      org: org || null,
      locale,
      amountCents: amount,
      reviewUrl: `${env.supabaseUrl}/functions/v1/pass-review?t=${pass.review_token}`,
      photoUrl,
    });

    await Promise.allSettled([
      sendMail({ to: env.mailReviewTo, subject: office.subject, html: office.html, replyTo: email })
        .then(() => logEvent(passId, "email", `review request -> ${env.mailReviewTo}`)),
      (() => {
        const m = receivedEmail({ name: firstName, type, locale });
        return sendMail({ to: email, subject: m.subject, html: m.html })
          .then(() => logEvent(passId, "email", `received -> ${email}`));
      })(),
    ]);

    return json(req, { ok: true, outcome: "review" });
  }

  // --- outcome 3: straight to checkout -------------------------------------
  const session = await createCheckoutSession({
    passId,
    type,
    locale,
    email,
    amountCents: amount,
  });

  await db()
    .from("passes")
    .update({ status: "awaiting_payment", stripe_session_id: session.id })
    .eq("id", passId);
  await logEvent(passId, "submitted", `checkout ${session.id}`);

  return json(req, { ok: true, outcome: "checkout", url: session.url });
}

// --- odds and ends ----------------------------------------------------------

function badge(code: string): string {
  return `${env.siteUrl}/badge/?c=${encodeURIComponent(code)}`;
}

function ext(mime: string): string {
  return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" }[mime] ?? "bin";
}

// Best effort: an orphaned upload is untidy, not dangerous.
async function cleanupFiles(photoPath: string | null, proofPath: string | null) {
  if (photoPath) await db().storage.from("pass-photos").remove([photoPath]).catch(() => {});
  if (proofPath) await db().storage.from("pass-docs").remove([proofPath]).catch(() => {});
}
