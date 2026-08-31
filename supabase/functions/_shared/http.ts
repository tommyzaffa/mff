// CORS and the small response helpers every function shares.

import { allowedOrigins } from "./env.ts";

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  // Echo the origin back only when we recognise it; anything else gets the
  // canonical site, which makes the browser refuse the response.
  const allow = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "vary": "origin",
  };
}

export function preflight(req: Request): Response | null {
  if (req.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "content-type": "application/json; charset=utf-8" },
  });
}

// Errors carry a machine-readable `code` so the page can show a translated
// message instead of whatever English string happens to be in here.
export function fail(req: Request, code: string, status = 400, detail?: string): Response {
  return json(req, { ok: false, error: code, detail }, status);
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
