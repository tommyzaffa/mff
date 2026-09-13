import { db } from "./db.ts";
import { env } from "./env.ts";
import { fail, preflight } from "./http.ts";
import { boundedRequest, RequestError } from "./request.ts";

// Persisted limits work across cold starts and parallel workers. The global
// budget also bounds abuse if the proxy's IP header can be spoofed. This does
// not replace an upstream WAF: an invocation has already reached Supabase.
export async function rateLimit(req: Request, scope: string, limit: number,
  globalLimit: number, seconds = 60): Promise<Response | null> {
  const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",").at(-1)!.trim();
  const bytes = new TextEncoder().encode(`${env.serviceRoleKey}:${ip.slice(0, 128)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const key = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
  const { data, error } = await db().rpc("security_rate_limit", {
    p_scope: scope, p_key: key, p_limit: limit, p_global_limit: globalLimit,
    p_seconds: seconds,
  });
  if (error) return fail(req, "service_unavailable", 503);
  if (data !== true) {
    const res = fail(req, "rate_limited", 429);
    res.headers.set("retry-after", String(seconds));
    return res;
  }
  return null;
}

export function secured(handler: (req: Request) => Promise<Response>, options: {
  scope: string; methods: string[]; maxBytes?: number; limit?: number; globalLimit?: number;
}) {
  return async (req: Request): Promise<Response> => {
    const pre = preflight(req);
    if (pre) return pre;
    if (!options.methods.includes(req.method)) return fail(req, "method_not_allowed", 405);
    try {
      if (options.limit) {
        const blocked = await rateLimit(req, options.scope, options.limit, options.globalLimit!);
        if (blocked) return blocked;
      }
      const max = req.headers.get("content-type")?.includes("application/json")
        ? Math.min(options.maxBytes ?? 16_384, options.scope === "pass-stripe-webhook" ? 262144 : 16_384)
        : options.maxBytes ?? 16_384;
      req = await boundedRequest(req, max);
      const response = await handler(req);
      // Redirect responses may have immutable headers.
      const headers = new Headers(response.headers);
      headers.set("cache-control", "no-store");
      headers.set("referrer-policy", "no-referrer");
      headers.set("x-content-type-options", "nosniff");
      return new Response(response.body, { status: response.status, headers });
    } catch (e) {
      if (e instanceof RequestError) return fail(req, e.code, e.status);
      console.error(`${options.scope}: unhandled failure`);
      return fail(req, "server_error", 500);
    }
  };
}
