-- Accreditations / passes — Merge Film Festival
--
-- Lives in the same Supabase project as the audience award, but touches none of
-- its objects: everything here is prefixed `pass_` (plus the `passes` table).
-- Safe to run before or after audience-award.sql.
--
-- Unlike the voting schema, the browser never talks to these tables. Passes hold
-- names, emails, photos and student documents, so the anon key gets nothing:
-- RLS is on and no policy is granted, which denies every operation outright.
-- All reads and writes go through the edge functions, which use the service role.
--
-- Run once in the Supabase SQL editor.

-- Supabase keeps extensions in their own schema, which is not always on the
-- search_path while a migration runs, so citext is referenced schema-qualified
-- below and both extensions are created before anything uses them.
set search_path = public, extensions;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext   with schema extensions;

-- ---------------------------------------------------------------------------
-- Vocabulary
-- ---------------------------------------------------------------------------

-- `guest_student` is a guest at the reduced fare, not a separate pass: it prints
-- the same violet G badge, just with a proof of enrolment on file.
do $$ begin
  create type public.pass_type as enum (
    'guest', 'guest_student', 'industry', 'press',
    'delegation', 'sponsor', 'staff', 'media'
  );
exception when duplicate_object then null; end $$;

-- The life of an application:
--   free / already paid ......... draft -> issued
--   paid pass ................... draft -> awaiting_payment -> paid -> issued
--   press & industry ............ draft -> pending_review -> awaiting_payment -> ...
--                                        \-> rejected
do $$ begin
  create type public.pass_status as enum (
    'draft', 'pending_review', 'rejected',
    'awaiting_payment', 'paid', 'issued', 'cancelled'
  );
exception when duplicate_object then null; end $$;

-- One place to change a price or a colour. The site reads this too, so the badge
-- and the checkout can never disagree about what a pass costs or looks like.
create table if not exists public.pass_kinds (
  type         public.pass_type primary key,
  letter       text not null check (length(letter) = 1),
  colour       text not null,          -- violet | red | grey
  price_cents  integer not null default 0 check (price_cents >= 0),
  needs_org    boolean not null default false,  -- production company / outlet / role
  needs_proof  boolean not null default false,  -- student card or enrolment letter
  needs_review boolean not null default false,  -- we approve before they can pay
  code_only    boolean not null default false,  -- only reachable with an access code
  sort         smallint not null default 0
);

insert into public.pass_kinds (type, letter, colour, price_cents, needs_org, needs_proof, needs_review, code_only, sort) values
  ('guest',         'G', 'violet', 4000, false, false, false, false, 1),
  ('guest_student', 'G', 'violet', 3000, false, true,  false, false, 2),
  ('industry',      'I', 'red',    4000, true,  false, true,  false, 3),
  ('press',         'P', 'red',    4000, true,  false, true,  false, 4),
  ('delegation',    'D', 'red',       0, true,  false, false, true,  5),
  ('sponsor',       'S', 'red',       0, true,  false, false, true,  6),
  ('staff',         'T', 'grey',      0, true,  false, false, true,  7),
  ('media',         'M', 'grey',      0, true,  false, false, true,  8)
on conflict (type) do update set
  letter = excluded.letter, colour = excluded.colour, price_cents = excluded.price_cents,
  needs_org = excluded.needs_org, needs_proof = excluded.needs_proof,
  needs_review = excluded.needs_review, code_only = excluded.code_only, sort = excluded.sort;

-- ---------------------------------------------------------------------------
-- Access codes
-- ---------------------------------------------------------------------------

-- One table for both jobs the festival needs:
--   * unlocking a free pass (delegation, sponsor, staff, media);
--   * waiving the fee on a paid one (a school gets one code good for 20 students).
-- `max_uses` null means unlimited — that is the standing internal code, and it
-- should never be handed out.
create table if not exists public.pass_access_codes (
  code          text primary key check (code ~ '^[A-Z0-9-]{4,32}$'),
  label         text not null,
  allowed_types public.pass_type[] not null check (array_length(allowed_types, 1) > 0),
  max_uses      integer check (max_uses is null or max_uses > 0),
  uses          integer not null default 0 check (uses >= 0),
  expires_at    timestamptz,
  is_active     boolean not null default true,
  note          text,
  created_at    timestamptz not null default now()
);

-- The festival's own master key: unlimited, every type, for passes we issue
-- ourselves at the desk. Rotate it by inserting a new one and deactivating this.
insert into public.pass_access_codes (code, label, allowed_types, max_uses, note) values
  ('MERGE-STAFF-MASTER-26', 'Master interno festival',
   array['guest','guest_student','industry','press','delegation','sponsor','staff','media']::public.pass_type[],
   null, 'Uso illimitato. Non distribuire: serve allo staff per emettere pass a mano.')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Badge numbers
-- ---------------------------------------------------------------------------

-- A pre-generated pool rather than a counter, so the number on a badge says
-- nothing about how many passes were sold and cannot be guessed from a
-- neighbour's. Handing one out is an update, which makes collisions impossible.
-- The alphabet drops 0/O/1/I so a number read aloud at the door is unambiguous.
create table if not exists public.pass_badge_codes (
  code        text primary key,
  pass_id     uuid,
  assigned_at timestamptz
);

create index if not exists pass_badge_codes_free_idx
  on public.pass_badge_codes (code) where pass_id is null;

create or replace function public.pass_fill_badge_pool(p_target integer default 5000)
returns integer language plpgsql as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  made integer := 0;
  guard integer := 0;
  candidate text;
begin
  while (select count(*) from public.pass_badge_codes) < p_target and guard < p_target * 20 loop
    guard := guard + 1;
    candidate := 'MFF-';
    for i in 1..4 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    candidate := candidate || '-';
    for i in 1..4 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    insert into public.pass_badge_codes (code) values (candidate) on conflict do nothing;
    if found then made := made + 1; end if;
  end loop;
  return made;
end;
$$;

select public.pass_fill_badge_pool(5000);

-- ---------------------------------------------------------------------------
-- Passes
-- ---------------------------------------------------------------------------

create table if not exists public.passes (
  id            uuid primary key default gen_random_uuid(),
  type          public.pass_type not null references public.pass_kinds(type),
  status        public.pass_status not null default 'draft',

  -- what the badge prints
  badge_code    text unique references public.pass_badge_codes(code),
  first_name    text not null check (length(btrim(first_name)) between 1 and 60),
  last_name     text not null check (length(btrim(last_name))  between 1 and 60),
  email         extensions.citext,
  org           text,                 -- production company, outlet, or role on staff
  photo_path    text,                 -- object key in the `pass-photos` bucket
  proof_path    text,                 -- object key in the `pass-docs` bucket

  -- money
  access_code   text references public.pass_access_codes(code),
  amount_cents  integer not null default 0 check (amount_cents >= 0),
  stripe_session_id     text unique,
  stripe_payment_intent text,
  paid_at       timestamptz,

  -- our approval, for press and industry
  review_token  text not null default encode(gen_random_bytes(24), 'hex'),
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text,

  issued_at     timestamptz,
  locale        text not null default 'it' check (locale in ('it','en','fr','de')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists passes_status_idx on public.passes (status);
create index if not exists passes_type_idx   on public.passes (type);
create index if not exists passes_email_idx  on public.passes (email);
create unique index if not exists passes_review_token_idx on public.passes (review_token);

-- One live pass per person per type. Withdrawn and rejected ones do not count,
-- so somebody who was turned down can apply again.
create unique index if not exists passes_one_per_email_idx
  on public.passes (email, type)
  where status not in ('rejected', 'cancelled');

create or replace function public.pass_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists passes_touch on public.passes;
create trigger passes_touch before update on public.passes
  for each row execute function public.pass_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Audit trail
-- ---------------------------------------------------------------------------

-- Append-only: who did what to a pass and when. It is what the dashboard shows
-- as a history, and what answers "did the confirmation email actually go out?".
create table if not exists public.pass_events (
  id         bigserial primary key,
  pass_id    uuid not null references public.passes(id) on delete cascade,
  kind       text not null,   -- submitted | approved | rejected | paid | issued | email | error
  detail     text,
  actor      text,            -- staff username, 'stripe', or null for the applicant
  created_at timestamptz not null default now()
);

create index if not exists pass_events_pass_idx on public.pass_events (pass_id, created_at);

-- ---------------------------------------------------------------------------
-- The two operations that must not race
-- ---------------------------------------------------------------------------

-- Claims a badge number for a pass. Idempotent: calling it twice returns the
-- number already held, so a replayed Stripe webhook cannot burn a second one.
create or replace function public.pass_claim_badge_code(p_pass uuid)
returns text language plpgsql security definer set search_path = public as $$
declare existing text; picked text;
begin
  select badge_code into existing from public.passes where id = p_pass;
  if existing is not null then return existing; end if;

  update public.pass_badge_codes
     set pass_id = p_pass, assigned_at = now()
   where code = (
     select code from public.pass_badge_codes
      where pass_id is null
      order by random() limit 1
      for update skip locked
   )
  returning code into picked;

  if picked is null then raise exception 'pass_badge_codes pool exhausted'; end if;

  update public.passes set badge_code = picked where id = p_pass;
  return picked;
end;
$$;

-- Burns one use of an access code, under a row lock so twenty people hitting
-- submit at once cannot turn a 20-use school code into 21 passes.
create or replace function public.pass_consume_access_code(p_code text, p_type public.pass_type)
returns boolean language plpgsql security definer set search_path = public as $$
declare row public.pass_access_codes%rowtype;
begin
  select * into row from public.pass_access_codes
   where code = upper(btrim(p_code)) for update;

  if not found then return false; end if;
  if not row.is_active then return false; end if;
  if row.expires_at is not null and row.expires_at < now() then return false; end if;
  if not (p_type = any (row.allowed_types)) then return false; end if;
  if row.max_uses is not null and row.uses >= row.max_uses then return false; end if;

  update public.pass_access_codes set uses = uses + 1 where code = row.code;
  return true;
end;
$$;

-- Gives a use back when a checkout is abandoned or a pass is cancelled, so a
-- school's twenty seats are not eaten by people who never paid.
create or replace function public.pass_release_access_code(p_code text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.pass_access_codes
     set uses = greatest(uses - 1, 0)
   where code = upper(btrim(p_code));
end;
$$;

-- ---------------------------------------------------------------------------
-- Views for the staff dashboard
-- ---------------------------------------------------------------------------

create or replace view public.pass_directory as
select
  p.id, p.type, k.letter, k.colour, p.status, p.badge_code,
  p.first_name, p.last_name, p.email, p.org,
  p.photo_path, p.proof_path,
  p.access_code, p.amount_cents, p.paid_at,
  -- The token travels with the row so the staff dashboard can drive the same
  -- approve/reject endpoint as the link in the email, instead of duplicating
  -- the Stripe and mail logic. The view is revoked from anon below.
  p.reviewed_by, p.reviewed_at, p.review_note, p.review_token,
  p.issued_at, p.locale, p.created_at
from public.passes p
join public.pass_kinds k on k.type = p.type
order by p.created_at desc;

create or replace view public.pass_stats as
select
  k.type,
  k.letter,
  k.colour,
  k.price_cents,
  count(p.id) filter (where p.status = 'issued')           as issued,
  count(p.id) filter (where p.status = 'pending_review')   as pending,
  count(p.id) filter (where p.status = 'awaiting_payment') as awaiting_payment,
  count(p.id) filter (where p.status = 'rejected')         as rejected,
  count(p.id)                                              as total,
  coalesce(sum(p.amount_cents) filter (where p.paid_at is not null), 0) as revenue_cents
from public.pass_kinds k
left join public.passes p on p.type = k.type
group by k.type, k.letter, k.colour, k.price_cents, k.sort
order by k.sort;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

-- On, with no policies at all. That denies anon and authenticated everything;
-- only the service role (edge functions, staff dashboard) gets through.
alter table public.passes            enable row level security;
alter table public.pass_access_codes enable row level security;
alter table public.pass_badge_codes  enable row level security;
alter table public.pass_events       enable row level security;

-- `pass_kinds` is the price list. It is public information and the site reads it
-- to build the chooser, so this one table is readable — nothing else is.
alter table public.pass_kinds enable row level security;
drop policy if exists pass_kinds_read on public.pass_kinds;
create policy pass_kinds_read on public.pass_kinds
  for select to anon, authenticated using (true);

revoke all on public.pass_directory from anon, authenticated;
revoke all on public.pass_stats     from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------

-- Both private. Uploads happen against a signed URL minted by the edge function
-- after it has validated the form, and the dashboard reads them through signed
-- download URLs, so the files are never publicly addressable.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pass-photos', 'pass-photos', false, 6291456,
        array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update set
  public = false, file_size_limit = 6291456,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pass-docs', 'pass-docs', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do update set
  public = false, file_size_limit = 10485760,
  allowed_mime_types = excluded.allowed_mime_types;
