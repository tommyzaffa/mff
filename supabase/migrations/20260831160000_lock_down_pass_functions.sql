-- Take the pass RPCs away from the browser.
--
-- PostgreSQL grants EXECUTE on every new function to PUBLIC, and PostgREST
-- happily exposes anything in `public` as /rest/v1/rpc/<name>. The three
-- helpers in passes.sql are `security definer`, so they bypass the RLS that is
-- supposed to keep the anon key out — which meant anyone holding the key (it is
-- in the page source of /vote/) could call them directly:
--
--   pass_consume_access_code  a free oracle for guessing access codes, and each
--                             correct guess burnt one of the seats
--   pass_release_access_code  handed a seat back, so a single leaked one-use
--                             code could be spent over and over
--   pass_claim_badge_code     drained the 5'000-number pool, and once it is
--                             empty no legitimate pass can be issued at all
--
-- They are only ever called by the edge functions, which connect as the service
-- role, so nobody else needs them.

revoke all on function public.pass_consume_access_code(text, public.pass_type)
  from public, anon, authenticated;
revoke all on function public.pass_release_access_code(text)
  from public, anon, authenticated;
revoke all on function public.pass_claim_badge_code(uuid)
  from public, anon, authenticated;
revoke all on function public.pass_fill_badge_pool(integer)
  from public, anon, authenticated;

grant execute on function public.pass_consume_access_code(text, public.pass_type) to service_role;
grant execute on function public.pass_release_access_code(text)                   to service_role;
grant execute on function public.pass_claim_badge_code(uuid)                      to service_role;
grant execute on function public.pass_fill_badge_pool(integer)                    to service_role;

-- Anything added later starts closed rather than open.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- Badge numbers handed to a pass that no longer exists — the three test passes
-- that were deleted, plus the two the audit itself claimed. Put them back in
-- the pool instead of leaving them spent.
update public.pass_badge_codes b
   set pass_id = null, assigned_at = null
 where b.pass_id is not null
   and not exists (select 1 from public.passes p where p.id = b.pass_id);
