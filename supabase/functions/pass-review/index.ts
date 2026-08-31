// GET  /functions/v1/pass-review?t=<token>   the approval page
// POST /functions/v1/pass-review             approve or reject
//
// This is the link in the email that lands in the festival inbox for press and
// industry requests. The token is the only credential, which is why the decision
// is taken on POST: mail clients and link scanners follow GETs, and none of them
// should be able to approve an accreditation by prefetching a link.

import { db, kind, logEvent, signedFileUrl, type Pass } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { html } from "../_shared/http.ts";
import { issuePass } from "../_shared/issue.ts";
import { sendMail, esc } from "../_shared/mail.ts";
import { approvedEmail, asLocale, passName, rejectedEmail } from "../_shared/templates.ts";
import { createCheckoutSession } from "../_shared/stripe.ts";

Deno.serve(async (req) => {
  const url = new URL(req.url);

  try {
    if (req.method === "GET") {
      const token = url.searchParams.get("t") ?? "";
      const pass = await byToken(token);
      if (!pass) return html(page("Link non valido", "<p>Questa richiesta non esiste più.</p>"), 404);
      return html(await reviewPage(pass, token));
    }

    if (req.method === "POST") {
      const form = await req.formData();
      const token = String(form.get("token") ?? "");
      const action = String(form.get("action") ?? "");
      const note = String(form.get("note") ?? "").trim();

      const pass = await byToken(token);
      if (!pass) return html(page("Link non valido", "<p>Questa richiesta non esiste più.</p>"), 404);

      if (pass.status !== "pending_review") {
        return html(page("Già gestita", `<p>Questa richiesta è già stata gestita (stato: <strong>${esc(pass.status)}</strong>).</p>`));
      }

      return action === "approve"
        ? html(await approve(pass, note))
        : action === "reject"
        ? html(await reject(pass, note))
        : html(page("Azione sconosciuta", "<p>Non ho capito cosa fare.</p>"), 400);
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (e) {
    console.error("pass-review", e);
    return html(page("Errore", `<p>Qualcosa è andato storto.</p><pre>${esc(String(e))}</pre>`), 500);
  }
});

async function byToken(token: string): Promise<Pass | null> {
  if (!/^[a-f0-9]{48}$/.test(token)) return null;
  const { data } = await db().from("passes").select("*").eq("review_token", token).maybeSingle();
  return (data as Pass) ?? null;
}

// --- decisions --------------------------------------------------------------

async function approve(pass: Pass, note: string): Promise<string> {
  const k = await kind(pass.type);
  const locale = asLocale(pass.locale);
  const amount = pass.amount_cents || k?.price_cents || 0;

  // An approved request that owes nothing is already done; otherwise the
  // applicant gets a checkout link and the pass waits for the webhook.
  if (amount === 0) {
    await db().from("passes").update({
      reviewed_at: new Date().toISOString(),
      review_note: note || null,
    }).eq("id", pass.id);
    await logEvent(pass.id, "approved", note || null, "email-link");
    const code = await issuePass({ ...pass, status: "awaiting_payment" });
    return page(
      "Approvata",
      `<p><strong>${esc(pass.first_name)} ${esc(pass.last_name)}</strong> è stato approvato e il
       badge <strong>${esc(code)}</strong> gli è già stato inviato per email.</p>`,
    );
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

  return page(
    "Approvata",
    `<p><strong>${esc(pass.first_name)} ${esc(pass.last_name)}</strong> è stato approvato per il
     ${esc(passName(pass.type, "it"))}.</p>
     <p>Gli è appena partita l'email con il link di pagamento. Il badge viene emesso da solo
     appena paga.</p>`,
  );
}

async function reject(pass: Pass, note: string): Promise<string> {
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

  return page(
    "Rifiutata",
    `<p>La richiesta di <strong>${esc(pass.first_name)} ${esc(pass.last_name)}</strong> è stata
     rifiutata e gliel'abbiamo comunicato.</p>`,
  );
}

// --- the page ---------------------------------------------------------------

async function reviewPage(pass: Pass, token: string): Promise<string> {
  if (pass.status !== "pending_review") {
    return page("Già gestita", `<p>Questa richiesta è già stata gestita (stato: <strong>${esc(pass.status)}</strong>).</p>`);
  }

  const k = await kind(pass.type);
  const photo = await signedFileUrl("pass-photos", pass.photo_path, 3600);
  const proof = await signedFileUrl("pass-docs", pass.proof_path, 3600);

  const rows = [
    ["Nome", `${pass.first_name} ${pass.last_name}`],
    ["Email", pass.email ?? "—"],
    ["Pass", passName(pass.type, "it")],
    [pass.type === "press" ? "Testata" : "Casa di produzione", pass.org ?? "—"],
    ["Importo", `CHF ${((pass.amount_cents || k?.price_cents || 0) / 100).toFixed(2)}`],
    ["Richiesta", new Date(pass.created_at).toLocaleString("it-CH")],
  ]
    .map(([a, b]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`)
    .join("");

  return page(
    "Richiesta di accredito",
    `<table class="kv">${rows}</table>
     ${photo ? `<img class="photo" src="${esc(photo)}" alt="Foto del richiedente">` : ""}
     ${proof ? `<p><a href="${esc(proof)}" target="_blank" rel="noopener">Apri il documento allegato</a></p>` : ""}

     <form method="post">
       <input type="hidden" name="token" value="${esc(token)}">
       <label class="note">Nota (facoltativa, viene inclusa nell'email di rifiuto)
         <textarea name="note" rows="3" placeholder="Es. posti stampa esauriti"></textarea>
       </label>
       <div class="actions">
         <button class="ok" name="action" value="approve" type="submit">Approva</button>
         <button class="no" name="action" value="reject" type="submit">Rifiuta</button>
       </div>
     </form>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="it"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Merge Film Festival</title>
<style>
  :root { --violet:#4B2E83; --cream:#F3F2EF; --ink:#0F0F12; }
  * { box-sizing:border-box }
  body { margin:0; padding:32px 18px; background:var(--cream); color:var(--ink);
         font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif }
  .card { max-width:560px; margin:0 auto; background:#fff; border-radius:22px; padding:30px; }
  h1 { font-size:24px; margin:0 0 18px }
  .kicker { font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--violet); margin:0 0 6px }
  table.kv { width:100%; border-collapse:collapse; margin:0 0 18px; font-size:15px }
  table.kv th { text-align:left; font-weight:400; color:#6b6b75; padding:6px 14px 6px 0; white-space:nowrap; vertical-align:top }
  table.kv td { padding:6px 0; font-weight:600 }
  .photo { width:130px; border-radius:14px; display:block; margin:0 0 18px }
  .note { display:block; font-size:13.5px; color:#6b6b75; margin:22px 0 16px }
  textarea { width:100%; margin-top:6px; padding:11px 12px; border:1px solid #ddd9d2; border-radius:12px;
             font:inherit; font-size:14.5px; resize:vertical }
  .actions { display:flex; gap:10px; flex-wrap:wrap }
  button { flex:1 1 150px; padding:14px 20px; border:0; border-radius:16px; font:inherit; font-weight:600;
           font-size:15px; cursor:pointer }
  .ok { background:var(--violet); color:var(--cream) }
  .no { background:#fff; color:#B3232B; border:1px solid #e3cfd0 }
  a { color:var(--violet) }
  pre { white-space:pre-wrap; font-size:12px; color:#8a8a93 }
</style></head><body>
<div class="card">
  <p class="kicker">Merge Film Festival — Accrediti</p>
  <h1>${esc(title)}</h1>
  ${body}
</div></body></html>`;
}
