-- Audience Award — Merge Film Festival
--
-- The public site is static, so the browser talks to Supabase directly with the
-- anon key. That key is visible to anyone who reads the page source, so every
-- rule that matters is enforced here rather than in the page:
--
--   * the anon key can read the schedule, but only published rows;
--   * it can insert a vote only while that screening's voting window is open;
--   * it can never read, update or delete a vote, so the tally cannot be
--     scraped or tampered with from the browser.
--
-- Run this once in the Supabase SQL editor.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------

-- `code` is what ends up in the QR link (/vote/?s=<code>), so keep it short and
-- URL-safe. Voting opens when the screening ends and closes a while later: a
-- narrow window is the main thing stopping someone from voting from home.
create table if not exists public.screenings (
  code         text primary key check (code ~ '^[a-z0-9][a-z0-9-]{1,23}$'),
  title        text not null,
  section      text,
  venue        text,
  starts_at    timestamptz not null,
  opens_at     timestamptz not null,
  closes_at    timestamptz not null,
  is_published boolean not null default true,
  created_at   timestamptz not null default now(),
  constraint screenings_window check (closes_at > opens_at)
);

-- ---------------------------------------------------------------------------
-- Votes
-- ---------------------------------------------------------------------------

-- `voter` is a random id the browser keeps in localStorage. It is client-side,
-- so a determined person can clear it and vote again — it stops the accidental
-- double tap and the casual repeat, not a motivated ballot stuffer. The voting
-- window above is the real defence.
create table if not exists public.votes (
  id         uuid primary key default gen_random_uuid(),
  screening  text not null references public.screenings(code) on delete cascade,
  score      smallint not null check (score between 1 and 10),
  voter      text not null check (length(voter) between 16 and 64),
  created_at timestamptz not null default now(),
  unique (screening, voter)
);

create index if not exists votes_screening_idx on public.votes (screening);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.screenings enable row level security;
alter table public.votes enable row level security;

drop policy if exists screenings_read_published on public.screenings;
create policy screenings_read_published on public.screenings
  for select to anon, authenticated
  using (is_published);

-- Insert only, and only inside the window. There is deliberately no select,
-- update or delete policy on votes: without one, RLS denies those outright.
drop policy if exists votes_insert_in_window on public.votes;
create policy votes_insert_in_window on public.votes
  for insert to anon, authenticated
  with check (
    exists (
      select 1
      from public.screenings s
      where s.code = votes.screening
        and s.is_published
        and now() >= s.opens_at
        and now() <  s.closes_at
    )
  );

-- ---------------------------------------------------------------------------
-- Results, for the staff
-- ---------------------------------------------------------------------------

-- Read this from the Supabase dashboard, which connects as the service role and
-- bypasses RLS. It is explicitly not granted to anon, so the standings stay
-- private until the festival decides to announce them.
create or replace view public.screening_results as
select
  s.code,
  s.title,
  s.section,
  s.venue,
  s.starts_at,
  count(v.id)                        as votes,
  round(avg(v.score)::numeric, 2)    as average
from public.screenings s
left join public.votes v on v.screening = s.code
group by s.code, s.title, s.section, s.venue, s.starts_at
order by average desc nulls last, votes desc;

revoke all on public.screening_results from anon, authenticated;
