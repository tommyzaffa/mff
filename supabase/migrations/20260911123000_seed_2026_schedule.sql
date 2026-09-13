-- The 2026 schedule, as sold — Merge Film Festival
--
-- Only the nine screenings that carry a ticket live here. The rest of the
-- programme (conferences, masterclasses, the parties, the awards ceremony and
-- the winners' screening) is free to walk into, so it needs no seat count, no
-- QR and no row: putting it in `screenings` would only give the door staff nine
-- real doors buried in thirty they never stand at.
--
-- Times are Europe/Zurich, CEST (+02) on 1-4 October 2026, and come from
-- "Programma DEFINITIVO Eventi Merge Film Festival". Where that sheet and the
-- "Proiezioni" sheet disagreed on the evening competition slots, the DEFINITIVO
-- is the one the festival is running.
--
-- `opens_at`/`closes_at` are NOT the sales window — they are the audience-award
-- VOTING window, from the older schema. Voting opens when the film ends and
-- runs three hours, which is narrow enough that a link forwarded the next
-- morning is already dead. Selling is governed by `sales_close_at`, left null
-- so the standing rule applies: 60 minutes before the start.
--
-- Idempotent: re-running corrects a row rather than failing on it.

set search_path = public, extensions;

insert into public.screenings (
  code, title, section, venue, starts_at, opens_at, closes_at,
  is_published, is_ticketed, capacity, wheelchair_spaces,
  price_cents, price_reduced_cents
) values
  -- The opening ceremony and the film are one event now, so the door opens at
  -- 20:30 and the ticket covers the whole evening. The film itself still ends
  -- at 23:00, which is where the voting window starts.
  ('retro-a', 'Cerimonia di apertura · Memory of Princess Mumbi', 'Retrospettiva',
   'Cinema Lux · Sala Cinema',
   '2026-10-01 20:30+02', '2026-10-01 23:00+02', '2026-10-02 02:00+02',
   true, true, 273, 2, 1500, 1000),

  ('retro-b', 'Retrospettiva · venerdì 2 ottobre', 'Retrospettiva',
   'Cinema Lux · Sala Cinema',
   '2026-10-02 10:00+02', '2026-10-02 12:00+02', '2026-10-02 15:00+02',
   true, true, 273, 2, 1500, 1000),

  ('concorso-1', 'Film in concorso · Programma 1', 'Concorso',
   'Cinema Lux · Sala Cinema',
   '2026-10-02 14:00+02', '2026-10-02 15:30+02', '2026-10-02 18:30+02',
   true, true, 273, 2, 1500, 1000),

  -- Preceded in the same room by the two Swiss awards, hence the 20:30 start.
  ('concorso-2', 'Premi svizzeri e Film in concorso · Programma 2', 'Concorso',
   'Cinema Lux · Sala Cinema',
   '2026-10-02 20:30+02', '2026-10-02 22:15+02', '2026-10-03 01:15+02',
   true, true, 273, 2, 1500, 1000),

  ('retro-c', 'Retrospettiva · sabato 3 ottobre', 'Retrospettiva',
   'Cinema Lux · Sala Cinema',
   '2026-10-03 10:00+02', '2026-10-03 12:00+02', '2026-10-03 15:00+02',
   true, true, 273, 2, 1500, 1000),

  ('concorso-3', 'Film in concorso · Programma 3', 'Concorso',
   'Cinema Lux · Sala Cinema',
   '2026-10-03 13:30+02', '2026-10-03 15:00+02', '2026-10-03 18:00+02',
   true, true, 273, 2, 1500, 1000),

  ('concorso-4', 'Film in concorso · Programma 4', 'Concorso',
   'Cinema Lux · Sala Cinema',
   '2026-10-03 15:30+02', '2026-10-03 17:00+02', '2026-10-03 20:00+02',
   true, true, 273, 2, 1500, 1000),

  -- Preceded in the same room by the Critics' Award, hence the 21:00 start.
  ('concorso-5', 'Premio della Critica e Film in concorso · Programma 5', 'Concorso',
   'Cinema Lux · Sala Cinema',
   '2026-10-03 21:00+02', '2026-10-03 22:30+02', '2026-10-04 01:30+02',
   true, true, 273, 2, 1500, 1000),

  ('retro-d', 'Retrospettiva · domenica 4 ottobre', 'Retrospettiva',
   'Cinema Lux · Sala Cinema',
   '2026-10-04 10:00+02', '2026-10-04 12:00+02', '2026-10-04 15:00+02',
   true, true, 273, 2, 1500, 1000)

on conflict (code) do update set
  title               = excluded.title,
  section             = excluded.section,
  venue               = excluded.venue,
  starts_at           = excluded.starts_at,
  opens_at            = excluded.opens_at,
  closes_at           = excluded.closes_at,
  is_published        = excluded.is_published,
  is_ticketed         = excluded.is_ticketed,
  capacity            = excluded.capacity,
  wheelchair_spaces   = excluded.wheelchair_spaces,
  price_cents         = excluded.price_cents,
  price_reduced_cents = excluded.price_reduced_cents;

-- Only Friday and Saturday. Thursday and Sunday have one ticketed screening
-- each, so a CHF 30 pass would cost twice the ticket it replaces — they are
-- absent rather than disabled, and nothing has to special-case them.
insert into public.festival_days (day, code, is_on_sale, price_cents, price_reduced_cents)
values
  ('2026-10-02', 'venerdi-2-ottobre', true, 3000, 2000),
  ('2026-10-03', 'sabato-3-ottobre',  true, 3000, 2000)
on conflict (day) do update set
  code                = excluded.code,
  is_on_sale          = excluded.is_on_sale,
  price_cents         = excluded.price_cents,
  price_reduced_cents = excluded.price_reduced_cents;

-- Anything left over from testing must not appear at a real door. Rows are
-- unpublished rather than deleted, because a deleted screening takes its
-- tickets with it (`on delete cascade`) and a test order is still a record of
-- what the system did.
update public.screenings
   set is_published = false
 where code not in ('retro-a', 'retro-b', 'retro-c', 'retro-d',
                    'concorso-1', 'concorso-2', 'concorso-3', 'concorso-4',
                    'concorso-5');
