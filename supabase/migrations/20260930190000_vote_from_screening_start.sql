-- Voting opens at the start of a competition screening and closes three
-- hours after its scheduled end. Existing closes_at values already encode
-- that closing time, so only change the opening edge.
update public.screenings s
   set opens_at = s.starts_at
 where exists (
   select 1 from public.films f where f.screening = s.code and f.is_published
 );

-- The public client needs explicit SQL privileges as well as the RLS policies.
-- It can read only published schedule rows and can only insert votes.
grant select on public.screenings, public.films to anon, authenticated;
revoke all on public.votes from anon, authenticated;
grant insert on public.votes to anon, authenticated;
