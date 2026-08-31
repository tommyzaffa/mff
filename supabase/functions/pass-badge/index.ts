// GET /functions/v1/pass-badge?c=MFF-XXXX-XXXX   the badge itself
// GET /functions/v1/pass-badge?p=<pass-id>       what happened to my payment
//
// The badge number is the credential. It is eight characters from a 32-symbol
// alphabet drawn at random out of a pool, so it cannot be guessed or walked, and
// knowing one tells you nothing about any other. That is deliberate: the badge
// has to survive being bookmarked, mailed to yourself and reopened at the door.
//
// The response never contains the email address, the student document or the
// access code — only what is printed on the badge.

import { db, kind, signedFileUrl } from "../_shared/db.ts";
import { fail, json, preflight } from "../_shared/http.ts";

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== "GET") return fail(req, "method_not_allowed", 405);

  const url = new URL(req.url);
  const code = (url.searchParams.get("c") ?? "").trim().toUpperCase();
  const passId = (url.searchParams.get("p") ?? "").trim();

  try {
    if (passId) return json(req, await paymentState(passId));
    if (code) return json(req, await badge(code));
    return fail(req, "bad_request");
  } catch (e) {
    console.error("pass-badge", e);
    return fail(req, "server_error", 500, String(e));
  }
});

async function badge(code: string) {
  if (!/^MFF-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return { ok: false, error: "not_found" };

  const { data } = await db()
    .from("passes")
    .select("id, type, status, badge_code, first_name, last_name, org, photo_path, issued_at")
    .eq("badge_code", code)
    .maybeSingle();

  if (!data || data.status !== "issued") return { ok: false, error: "not_found" };

  const k = await kind(data.type);

  return {
    ok: true,
    badge: {
      code: data.badge_code,
      type: data.type,
      letter: k?.letter ?? "?",
      colour: k?.colour ?? "violet",
      first_name: data.first_name,
      last_name: data.last_name,
      // A guest's badge carries no label; everyone else's says where they are from.
      org: k?.needs_org ? data.org : null,
      // A week is long enough that the page never shows a broken image between
      // one visit and the next, and short enough that a leaked URL goes stale.
      photo_url: await signedFileUrl("pass-photos", data.photo_path, 60 * 60 * 24 * 7),
      issued_at: data.issued_at,
    },
  };
}

// What the page you land on after Stripe asks, while the webhook catches up.
async function paymentState(passId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(passId)) return { ok: false, error: "not_found" };

  const { data } = await db()
    .from("passes")
    .select("status, badge_code, first_name")
    .eq("id", passId)
    .maybeSingle();

  if (!data) return { ok: false, error: "not_found" };

  return {
    ok: true,
    status: data.status,
    first_name: data.first_name,
    badge_code: data.status === "issued" ? data.badge_code : null,
  };
}
