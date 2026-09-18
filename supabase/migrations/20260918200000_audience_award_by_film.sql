-- Premio del pubblico: si votano i film, non i blocchi
--
-- La prima versione teneva il voto sulla riga di `screenings`, cioè sul
-- programma: chi usciva dal Programma 3 dava un numero a "Film in concorso ·
-- Programma 3", otto corti in una media sola. Non è un premio del pubblico, è
-- un sondaggio sulla scaletta. E mandava ai voti anche retrospettive e
-- cerimonie, che in concorso non ci sono.
--
-- Da qui il voto sta sul film. `films` elenca i 36 corti in gara e dice in
-- quale proiezione passa ciascuno; la finestra di voto resta quella del blocco
-- (si apre quando il blocco finisce e dura tre ore), perché è l'unica cosa che
-- il pubblico ha davvero vissuto: esce dalla sala e vota quello che ha appena
-- visto. Una proiezione senza film in gara non ha semplicemente nulla da
-- votare — retrospettive e cerimonie spariscono dal giro senza una riga di
-- codice che le nomini.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- I film in gara
-- ---------------------------------------------------------------------------

-- `slug` è quello delle pagine del sito (in_competition/<section>/<slug>.html),
-- così la scheda del film e la sua riga qui si trovano da sole.
-- `position` è l'ordine di proiezione dentro il blocco: la lista che il
-- pubblico vede sul telefono deve essere nell'ordine in cui ha visto i film,
-- altrimenti cerca il titolo invece di riconoscerlo.
create table if not exists public.films (
  slug         text primary key check (slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  title        text not null,
  section      text not null check (section in ('full', 'hybrid', 'experimental')),
  screening    text not null references public.screenings(code) on delete cascade,
  position     smallint not null,
  is_published boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (screening, position)
);

create index if not exists films_screening_idx on public.films (screening);

insert into public.films (slug, title, section, screening, position) values
  -- Programma 1 — venerdì 2 ottobre, 14:00
  ('closed-waters',                  'Closed Waters',                                    'full',         'concorso-1', 1),
  ('lets-play-ball',                 'Let’s Play Ball',                                  'full',         'concorso-1', 2),
  ('the-listening-flower',           'The Listening Flower',                             'experimental', 'concorso-1', 3),
  ('the-gosari-monsoon',             'The Gosari Monsoon',                               'full',         'concorso-1', 4),
  ('hey-up',                         'Hey, UP!!!',                                       'full',         'concorso-1', 5),
  ('catatumbo',                      'Catatumbo: House of Thunder, Memory, and Dignity',  'full',         'concorso-1', 6),
  ('rodeo-of-the-mouse',             'Rodeo of the Mouse',                               'full',         'concorso-1', 7),

  -- Programma 2 — venerdì 2 ottobre, 20:30 (dopo i premi svizzeri)
  ('the-descent-of-species',         'The Descent of Species',                           'hybrid',       'concorso-2', 1),
  ('little-mes',                     'Little Mes',                                       'full',         'concorso-2', 2),
  ('passenger',                      'Passenger',                                        'full',         'concorso-2', 3),
  ('commit',                         'Commit',                                           'full',         'concorso-2', 4),
  ('unum',                           'Unum',                                             'experimental', 'concorso-2', 5),
  ('a-message-for-the-butterfly',    'A Message for the Butterfly',                      'full',         'concorso-2', 6),

  -- Programma 3 — sabato 3 ottobre, 13:30
  ('home',                           'Home',                                             'hybrid',       'concorso-3', 1),
  ('bronze-bust-digital-guard',      'Bronze bust, digital guard',                       'hybrid',       'concorso-3', 2),
  ('the-six-eared-macaque',          'The Six-Eared Macaque',                            'full',         'concorso-3', 3),
  ('whats-locked-behind-that-door',  'What’s Locked Behind That Door?',                  'experimental', 'concorso-3', 4),
  ('developed',                      'Developed',                                        'full',         'concorso-3', 5),
  ('symptoms-of-multiple-sclerosis', 'Symptoms of Multiple Sclerosis',                   'hybrid',       'concorso-3', 6),
  ('broken',                         'broken',                                           'experimental', 'concorso-3', 7),
  ('kite',                           'Kite',                                             'full',         'concorso-3', 8),

  -- Programma 4 — sabato 3 ottobre, 15:30
  ('the-end-of-the-plastic-age',     'The End of the Plastic Age',                       'full',         'concorso-4', 1),
  ('you-will-always-be-welcome-here','You Will Always Be Welcome Here',                  'hybrid',       'concorso-4', 2),
  ('data-center-by-night',           'Data Center by Night',                             'experimental', 'concorso-4', 3),
  ('le-drip',                        'Le drip',                                          'full',         'concorso-4', 4),
  ('the-morisca',                    'The Morisca',                                      'full',         'concorso-4', 5),
  ('bee-with-me',                    'Bee With Me',                                      'full',         'concorso-4', 6),
  ('short-circuit',                  'Short Circuit',                                    'hybrid',       'concorso-4', 7),
  ('pillow-men',                     'Pillow Men',                                       'experimental', 'concorso-4', 8),

  -- Programma 5 — sabato 3 ottobre, 21:00 (dopo il Premio della Critica)
  ('ai-manifesto-2026',              'AI Manifesto 2026',                                'hybrid',       'concorso-5', 1),
  ('the-howl',                       'The Howl',                                         'experimental', 'concorso-5', 2),
  ('the-tale-of-the-peony',          'The Tale of the Peony',                            'full',         'concorso-5', 3),
  ('a-face-only-a-mother-could-love','A Face Only A Mother Could Love',                  'full',         'concorso-5', 4),
  ('between-before-and-after',       'Between Before and After',                         'full',         'concorso-5', 5),
  ('railbound',                      'Railbound',                                        'hybrid',       'concorso-5', 6),
  ('malignant-catatonic',            'Malignant / Catatonic',                            'experimental', 'concorso-5', 7)

on conflict (slug) do update set
  title     = excluded.title,
  section   = excluded.section,
  screening = excluded.screening,
  position  = excluded.position;

-- ---------------------------------------------------------------------------
-- Il voto passa dal blocco al film
-- ---------------------------------------------------------------------------

-- La vecchia policy e la vecchia vista leggono `votes.screening`: finché
-- esistono, la colonna non si può togliere. Vanno giù per prime; la policy
-- nuova arriva più sotto, la vista è sostituita da `film_results`.
drop policy if exists votes_insert_in_window on public.votes;
drop view if exists public.screening_results;

-- Il festival non è ancora successo e la tabella è vuota, quindi la colonna
-- nasce già NOT NULL senza backfill: se una riga esistesse davvero, il comando
-- fallirebbe invece di inventarle un film, che è il verso giusto.
alter table public.votes
  add column if not exists film text references public.films(slug) on delete cascade;

alter table public.votes alter column film set not null;

-- Togliendo la colonna cade con lei il vincolo unique (screening, voter).
alter table public.votes drop column if exists screening;

create unique index if not exists votes_film_voter_idx on public.votes (film, voter);
create index if not exists votes_film_idx on public.votes (film);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.films enable row level security;

drop policy if exists films_read_published on public.films;
create policy films_read_published on public.films
  for select to anon, authenticated
  using (is_published);

-- Un voto entra solo se il film è in gara e la finestra del suo blocco è
-- aperta adesso, con l'orologio del server. Resta senza policy di select,
-- update e delete: senza policy RLS nega, quindi la classifica non si può né
-- leggere né ritoccare dal browser.
create policy votes_insert_in_window on public.votes
  for insert to anon, authenticated
  with check (
    exists (
      select 1
      from public.films f
      join public.screenings s on s.code = f.screening
      where f.slug = votes.film
        and f.is_published
        and s.is_published
        and now() >= s.opens_at
        and now() <  s.closes_at
    )
  );

grant select on public.films to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Cosa si può votare adesso
-- ---------------------------------------------------------------------------

-- La pagina di voto è statica e parla da sola con PostgREST: le serve una sola
-- domanda, "cosa posso votare?", e questa vista gliela fa fare in una richiesta
-- sola. `security_invoker` perché il filtro deve restare quello di RLS, non
-- quello del proprietario della vista.
drop view if exists public.votable_films;
create view public.votable_films
  with (security_invoker = on) as
select
  f.slug,
  f.title,
  f.section,
  f.position,
  s.code       as screening,
  s.title      as screening_title,
  s.venue,
  s.starts_at,
  s.opens_at,
  s.closes_at
from public.films f
join public.screenings s on s.code = f.screening
where f.is_published and s.is_published;

grant select on public.votable_films to anon, authenticated;

-- ---------------------------------------------------------------------------
-- La classifica, per lo staff
-- ---------------------------------------------------------------------------

-- Il premio si assegna sulla media, ma una media di due voti non è un premio:
-- `votes` sta accanto apposta. Niente grant ad anon: si legge con la service
-- role (dashboard Supabase, oppure Merge → Voti del pubblico nel gestionale).
create or replace view public.film_results as
select
  f.slug,
  f.title,
  f.section,
  f.screening,
  s.title                         as screening_title,
  s.starts_at,
  f.position,
  count(v.id)                     as votes,
  round(avg(v.score)::numeric, 2) as average
from public.films f
join public.screenings s on s.code = f.screening
left join public.votes v on v.film = f.slug
where f.is_published
group by f.slug, f.title, f.section, f.screening, s.title, s.starts_at, f.position;

revoke all on public.film_results from anon, authenticated;
