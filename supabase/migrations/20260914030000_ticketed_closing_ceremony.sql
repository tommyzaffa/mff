-- The closing ceremony is ticketed — Merge Film Festival
--
-- The printed programme of 14 September 2026 prices the Sunday awards ceremony
-- and the winners' screening at CHF 15.– / rid. 10.–, like the opening night.
-- It was free when `20260911123000_seed_2026_schedule.sql` ran, so it had no
-- row at all: the door now needs one, with a QR and a seat count.
--
-- Sunday still has no day pass. Two ticketed screenings at CHF 15.– come to
-- exactly the CHF 30.– a pass costs, so the pass would save nobody anything.

set search_path = public, extensions;

insert into public.screenings (
  code, title, section, venue, starts_at, opens_at, closes_at,
  is_published, is_ticketed, capacity, wheelchair_spaces,
  price_cents, price_reduced_cents
) values
  ('premiazione', 'Cerimonia di premiazione e proiezione dei film vincitori',
   'Premiazione', 'Cinema Lux · Sala Cinema',
   '2026-10-04 15:00+02', '2026-10-04 16:00+02', '2026-10-04 19:00+02',
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
