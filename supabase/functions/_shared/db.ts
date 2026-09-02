// Service-role Supabase client. RLS denies everything on the pass tables, so
// this is the only way in — which is exactly why it lives server-side only.

// Pinned, not a `@2` range. On 2 Sep 2026 supabase-js 2.114.0 was published to
// jsr depending on an auth-js 2.114.0 that never reached npm, and every deploy
// started failing to bundle — with the range, code that had not changed became
// undeployable overnight. During the festival that would be the difference
// between a fixable bug and a dead box office.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2.113.0";
import { env } from "./env.ts";

let cached: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!cached) {
    cached = createClient(env.supabaseUrl, env.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return cached;
}

export type PassKind = {
  type: string;
  letter: string;
  colour: string;
  price_cents: number;
  needs_org: boolean;
  needs_proof: boolean;
  needs_review: boolean;
  code_only: boolean;
  sort: number;
};

export type Pass = {
  id: string;
  type: string;
  status: string;
  badge_code: string | null;
  first_name: string;
  last_name: string;
  email: string | null;
  org: string | null;
  photo_path: string | null;
  proof_path: string | null;
  access_code: string | null;
  amount_cents: number;
  stripe_session_id: string | null;
  review_token: string;
  issued_at: string | null;
  locale: string;
  created_at: string;
};

export async function kind(type: string): Promise<PassKind | null> {
  const { data } = await db().from("pass_kinds").select("*").eq("type", type).maybeSingle();
  return (data as PassKind) ?? null;
}

export async function logEvent(passId: string, kind: string, detail?: string, actor?: string) {
  // Never let a failed audit write break the flow it is describing.
  await db().from("pass_events").insert({ pass_id: passId, kind, detail, actor }).then(
    () => {},
    () => {},
  );
}

// A short-lived link the applicant (or the staff dashboard) can use to see a
// file that is otherwise unreachable.
export async function signedFileUrl(
  bucket: string,
  path: string | null,
  seconds = 3600,
): Promise<string | null> {
  if (!path) return null;
  const { data } = await db().storage.from(bucket).createSignedUrl(path, seconds);
  return data?.signedUrl ?? null;
}
