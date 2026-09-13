-- Two tariffs and a day pass — Merge Film Festival
--
-- 1. Reduced tariff. Students and over-65s pay CHF 10 instead of 15 (and 20
--    instead of 30 for a day pass). It is declared when buying and verified at
--    the door, so the tariff has to travel all the way to the scanner: the
--    price alone is not enough, the staff need the word "RIDOTTO" on screen to
--    know they must ask for a card. Hence a column on `tickets` rather than a
--    second `price_cents` lookup at display time.
--
-- 2. Day pass. One code that gets its holder into every ticketed screening of
--    one festival day. Deliberately NOT a new admission mechanism: a day pass
--    simply owns one ordinary `tickets` row per screening of that day, tied
--    together by `day_pass_code`. That keeps a single definition of a taken
--    seat, so `screening_availability` counts a day-pass holder correctly with
--    no change at all, and the door scanner resolves the code to the seat for
--    the screening in front of it exactly as it already does for a badge.
--
-- A day pass is sold only while at least one of the day's screenings is still
-- open online, and it reserves a seat only in the screenings that are still
-- open at that moment. Buying at 18:00 therefore cannot conjure a seat in the
-- 14:00 show that has already started, and the capacity arithmetic stays the
-- arithmetic the room actually has.
--
-- Code shapes: a ticket is 'MFF-T-XXXXXXXX', a day pass 'MFF-D-XXXXXXXX' and a
-- badge 'MFF-XXXX-XXXX'. Position 6 is a hyphen in the first two and a letter
-- in the third, and position 5 tells T from D, so `like` routing is exact.
--
-- Like everything else here: RLS on with no policy, edge functions only.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Shared helper
-- ---------------------------------------------------------------------------

-- Pulled out of the places that were generating the same suffix, so the
-- alphabet with no look-alikes is defined once. Volatile on purpose: marking it
-- immutable would let the planner call it once and hand every seat one code.
create or replace function public.ticket_random_suffix()
returns text language sql volatile as $$
  select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                           1 + floor(random() * 32)::int, 1), '')
    from generate_series(1, 8);
$$;

-- ---------------------------------------------------------------------------
-- Prices
-- ---------------------------------------------------------------------------

alter table public.screenings
  add column if not exists price_reduced_cents integer not null default 0
    check (price_reduced_cents >= 0);

comment on column public.screenings.price_reduced_cents is
  'Students and over-65s. Self-declared online, checked at the door.';

-- Which tariff this seat was sold at. 'accredited' is its own value rather than
-- a zero-franc 'full', because the door does different things with them: an
-- accredited seat needs no proof, a reduced one does.
alter table public.tickets
  add column if not exists tariff text not null default 'full'
    check (tariff in ('full', 'reduced', 'accredited'));

-- Seats booked before this column existed took the 'full' default, which would
-- have the door asking an accredited guest for a student card.
update public.tickets set tariff = 'accredited'
 where badge_code is not null and tariff = 'full';

-- The box office sells at both tariffs too. The delta is still what the seat
-- count is made of; this only says what was charged for it, so the takings can
-- be reconciled without a second ledger.
alter table public.screening_door_sales
  add column if not exists tariff text not null default 'full'
    check (tariff in ('full', 'reduced'));

-- ---------------------------------------------------------------------------
-- The days a pass can be bought for
-- ---------------------------------------------------------------------------

-- Only the days worth selling one for. Thursday and Sunday have a single
-- ticketed screening each, so a day pass there would cost double a ticket —
-- they are simply absent from this table and no page has to special-case them.
create table if not exists public.festival_days (
  day                 date primary key,
  code                text unique not null
    check (code ~ '^[a-z0-9][a-z0-9-]{1,23}$'),
  is_on_sale          boolean not null default true,
  price_cents         integer not null default 0 check (price_cents >= 0),
  price_reduced_cents integer not null default 0 check (price_reduced_cents >= 0),
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Orders that span a whole day
-- ---------------------------------------------------------------------------

-- An order was one screening by definition. A day pass is the one thing that
-- legitimately spans several, so the column becomes nullable and a sibling
-- `day` takes over; the check keeps exactly one of the two set, which is what
-- stops an order from being quietly neither.
alter table public.ticket_orders
  alter column screening drop not null;

alter table public.ticket_orders
  add column if not exists day date references public.festival_days(day);

do $$ begin
  alter table public.ticket_orders
    add constraint ticket_orders_screening_xor_day
    check ((screening is null) <> (day is null));
exception when duplicate_object then null; end $$;

-- The code the buyer is actually given. Not unique: it repeats across the
-- sibling seats of the same day, which is the whole point — one QR, every door.
alter table public.tickets
  add column if not exists day_pass_code text;

create index if not exists tickets_day_pass_idx
  on public.tickets (day_pass_code, screening)
  where day_pass_code is not null;

create index if not exists ticket_orders_day_idx
  on public.ticket_orders (day, status) where day is not null;

-- `create or replace view` can only append, so the reduced price goes on the
-- end rather than next to `price_cents` where it belongs.
create or replace view public.screening_availability as
select
  s.code,
  s.title,
  s.section,
  s.venue,
  s.starts_at,
  s.is_published,
  s.is_ticketed,
  s.capacity,
  s.wheelchair_spaces,
  s.price_cents,
  public.screening_sales_close(s.*) as sales_close_at,
  s.sales_open_at,
  (now() >= coalesce(s.sales_open_at, '-infinity'::timestamptz)
   and now() < public.screening_sales_close(s.*))          as sales_open,

  coalesce(t.online_taken, 0)                              as online_taken,
  coalesce(d.door_sold, 0)                                 as door_sold,
  coalesce(t.wheelchair_taken, 0)                          as wheelchair_taken,

  greatest(s.capacity - coalesce(t.online_taken, 0) - coalesce(d.door_sold, 0), 0)
                                                           as seats_left,
  greatest(s.wheelchair_spaces - coalesce(t.wheelchair_taken, 0), 0)
                                                           as wheelchair_left,
  s.price_reduced_cents,
  -- Split only for the till: the seat count above is the sum of the two, and
  -- the box office page needs to know which of its two buttons to undo.
  coalesce(d.door_full, 0)                                 as door_full,
  coalesce(d.door_reduced, 0)                              as door_reduced
from public.screenings s
left join lateral (
  select
    count(*) filter (where not tk.wheelchair) as online_taken,
    count(*) filter (where tk.wheelchair)     as wheelchair_taken
  from public.tickets tk
  join public.ticket_orders o on o.id = tk.order_id
  where tk.screening = s.code
    and tk.cancelled_at is null
    and (o.status = 'issued'
         or (o.status = 'held' and o.holds_until > now()))
) t on true
left join lateral (
  select
    coalesce(sum(delta), 0)                                          as door_sold,
    coalesce(sum(delta) filter (where ds.tariff = 'full'), 0)        as door_full,
    coalesce(sum(delta) filter (where ds.tariff = 'reduced'), 0)     as door_reduced
  from public.screening_door_sales ds
  where ds.screening = s.code
) d on true;

revoke all on public.screening_availability from anon, authenticated;
grant select on public.screening_availability to service_role;

-- ---------------------------------------------------------------------------
-- Reserving single seats, now with tariffs
-- ---------------------------------------------------------------------------

-- Unchanged except that a seat may now carry {"tariff":"reduced"}. A seat with
-- a badge is free whatever it claims, so the badge wins and the tariff is
-- recorded as 'accredited' — otherwise the door would be asked for a student
-- card that the accreditation already makes irrelevant.
create or replace function public.ticket_reserve(
  p_screening  text,
  p_first_name text,
  p_last_name  text,
  p_email      text,
  p_seats      jsonb,
  p_locale     text default 'it',
  p_hold_mins  integer default 20
)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  s           public.screenings%rowtype;
  closes_at   timestamptz;
  seat        jsonb;
  badge       text;
  tariff      text;
  price       integer;
  n_seats     integer;
  want_normal integer := 0;
  want_chair  integer := 0;
  has_normal  integer;
  has_chair   integer;
  door        integer;
  total       integer := 0;
  order_id    uuid;
  new_code    text;
  codes       text[] := '{}';
begin
  if p_seats is null or jsonb_typeof(p_seats) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  n_seats := jsonb_array_length(p_seats);
  if n_seats < 1 or n_seats > 10 then
    return jsonb_build_object('ok', false, 'reason', 'bad_seat_count');
  end if;

  -- The lock is the whole point: hold it from the count to the insert.
  select * into s from public.screenings
   where code = p_screening for update;

  if not found or not s.is_published then
    return jsonb_build_object('ok', false, 'reason', 'unknown_screening');
  end if;
  if not s.is_ticketed then
    return jsonb_build_object('ok', false, 'reason', 'not_ticketed');
  end if;

  closes_at := public.screening_sales_close(s);
  if s.sales_open_at is not null and now() < s.sales_open_at then
    return jsonb_build_object('ok', false, 'reason', 'sales_not_open',
                              'opens_at', s.sales_open_at);
  end if;
  if now() >= closes_at then
    return jsonb_build_object('ok', false, 'reason', 'sales_closed',
                              'closed_at', closes_at);
  end if;

  -- Validate every seat before taking any, so a party is never half-booked.
  for seat in select * from jsonb_array_elements(p_seats) loop
    badge  := nullif(btrim(upper(coalesce(seat->>'badge', ''))), '');
    tariff := lower(coalesce(nullif(btrim(seat->>'tariff'), ''), 'full'));

    if tariff not in ('full', 'reduced') then
      return jsonb_build_object('ok', false, 'reason', 'bad_tariff');
    end if;

    if coalesce((seat->>'wheelchair')::boolean, false)
      then want_chair := want_chair + 1;
      else want_normal := want_normal + 1;
    end if;

    if badge is null then
      total := total + case when tariff = 'reduced'
                            then s.price_reduced_cents else s.price_cents end;
    else
      if not exists (
        select 1 from public.pass_badge_codes b
        join public.passes p on p.id = b.pass_id
        where b.code = badge and p.status = 'issued'
      ) then
        return jsonb_build_object('ok', false, 'reason', 'unknown_badge',
                                  'badge', badge);
      end if;

      if exists (
        select 1 from public.tickets
         where screening = p_screening and badge_code = badge
           and cancelled_at is null
      ) then
        return jsonb_build_object('ok', false, 'reason', 'badge_already_used',
                                  'badge', badge);
      end if;
    end if;
  end loop;

  -- Two seats booked on the same badge inside this one request would each pass
  -- the check above, since neither is committed yet. Catch it here.
  if (select count(distinct upper(btrim(x->>'badge')))
        from jsonb_array_elements(p_seats) x
       where nullif(btrim(x->>'badge'), '') is not null)
     <> (select count(*)
           from jsonb_array_elements(p_seats) x
          where nullif(btrim(x->>'badge'), '') is not null)
  then
    return jsonb_build_object('ok', false, 'reason', 'badge_repeated');
  end if;

  select
    count(*) filter (where not tk.wheelchair),
    count(*) filter (where tk.wheelchair)
    into has_normal, has_chair
  from public.tickets tk
  join public.ticket_orders o on o.id = tk.order_id
  where tk.screening = p_screening
    and tk.cancelled_at is null
    and (o.status = 'issued' or (o.status = 'held' and o.holds_until > now()));

  select coalesce(sum(delta), 0) into door
  from public.screening_door_sales where screening = p_screening;

  if want_normal > s.capacity - has_normal - door then
    return jsonb_build_object('ok', false, 'reason', 'sold_out',
      'seats_left', greatest(s.capacity - has_normal - door, 0));
  end if;
  if want_chair > s.wheelchair_spaces - has_chair then
    return jsonb_build_object('ok', false, 'reason', 'no_wheelchair_space',
      'wheelchair_left', greatest(s.wheelchair_spaces - has_chair, 0));
  end if;

  -- A wholly accredited party owes nothing and is admitted immediately; an
  -- order with anything to pay is only a hold until Stripe says otherwise.
  insert into public.ticket_orders (
    screening, status, first_name, last_name, email,
    amount_cents, holds_until, issued_at, locale
  ) values (
    p_screening,
    -- The cast is not decoration: two bare literals inside a CASE resolve to
    -- `text`, and PostgreSQL will not assign text to an enum column on its own.
    (case when total = 0 then 'issued' else 'held' end)::public.ticket_order_status,
    btrim(p_first_name), btrim(p_last_name), p_email::extensions.citext,
    total,
    case when total = 0 then null else now() + make_interval(mins => p_hold_mins) end,
    case when total = 0 then now() else null end,
    p_locale
  )
  returning id into order_id;

  for seat in select * from jsonb_array_elements(p_seats) loop
    badge  := nullif(btrim(upper(coalesce(seat->>'badge', ''))), '');
    tariff := lower(coalesce(nullif(btrim(seat->>'tariff'), ''), 'full'));
    if badge is not null then
      tariff := 'accredited';
      price  := 0;
    else
      price := case when tariff = 'reduced'
                    then s.price_reduced_cents else s.price_cents end;
    end if;

    -- 32^8 codes from an alphabet with no look-alikes, so a number read out at
    -- the door is unambiguous and cannot be guessed from a neighbour's.
    loop
      new_code := 'MFF-T-' || public.ticket_random_suffix();
      exit when not exists (select 1 from public.tickets where code = new_code);
    end loop;

    insert into public.tickets (
      code, order_id, screening, badge_code, holder_name, wheelchair,
      amount_cents, tariff
    ) values (
      new_code, order_id, p_screening, badge,
      nullif(btrim(coalesce(seat->>'holder', '')), ''),
      coalesce((seat->>'wheelchair')::boolean, false),
      price, tariff
    );

    codes := codes || new_code;
  end loop;

  return jsonb_build_object(
    'ok', true, 'order_id', order_id, 'codes', to_jsonb(codes),
    'amount_cents', total, 'free', total = 0,
    'seats_left', s.capacity - has_normal - door - want_normal);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reserving a day pass
-- ---------------------------------------------------------------------------

-- Locks every screening it is about to book, in `code` order. The order matters
-- and is not cosmetic: two day-pass buyers taking the same set of rows in the
-- same sequence queue up, whereas two taking them in opposite orders deadlock.
-- `ticket_reserve` only ever locks one row, so it cannot deadlock against this.
--
-- Unlike `ticket_reserve` there is no badge path: an accreditation already
-- gives a free seat at every screening, so a day pass on top of one would be
-- money for nothing and is refused rather than silently sold.
create or replace function public.ticket_day_pass_reserve(
  p_day        date,
  p_first_name text,
  p_last_name  text,
  p_email      text,
  p_seats      jsonb,
  p_locale     text default 'it',
  p_hold_mins  integer default 20
)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  fd          public.festival_days%rowtype;
  s           public.screenings%rowtype;
  seat        jsonb;
  tariff      text;
  n_seats     integer;
  want_normal integer := 0;
  want_chair  integer := 0;
  has_normal  integer;
  has_chair   integer;
  door        integer;
  total       integer := 0;
  order_id    uuid;
  shows       text[] := '{}';
  show_code   text;
  pass_code   text;
  seat_code   text;
  codes       text[] := '{}';
begin
  if p_seats is null or jsonb_typeof(p_seats) <> 'array' then
    return jsonb_build_object('ok', false, 'reason', 'bad_request');
  end if;

  n_seats := jsonb_array_length(p_seats);
  if n_seats < 1 or n_seats > 10 then
    return jsonb_build_object('ok', false, 'reason', 'bad_seat_count');
  end if;

  select * into fd from public.festival_days where day = p_day;
  if not found or not fd.is_on_sale then
    return jsonb_build_object('ok', false, 'reason', 'unknown_day');
  end if;

  -- Locked in `code` order, and only the screenings still open online: a pass
  -- must never promise a seat in a show the site can no longer sell.
  for s in
    select sc.* from public.screenings sc
     where sc.is_published and sc.is_ticketed
       and (sc.starts_at at time zone 'Europe/Zurich')::date = p_day
       and now() < public.screening_sales_close(sc.*)
       and now() >= coalesce(sc.sales_open_at, '-infinity'::timestamptz)
     order by sc.code
     for update
  loop
    shows := shows || s.code;
  end loop;

  if array_length(shows, 1) is null then
    return jsonb_build_object('ok', false, 'reason', 'sales_closed');
  end if;

  for seat in select * from jsonb_array_elements(p_seats) loop
    if nullif(btrim(coalesce(seat->>'badge', '')), '') is not null then
      return jsonb_build_object('ok', false, 'reason', 'badge_on_day_pass');
    end if;

    tariff := lower(coalesce(nullif(btrim(seat->>'tariff'), ''), 'full'));
    if tariff not in ('full', 'reduced') then
      return jsonb_build_object('ok', false, 'reason', 'bad_tariff');
    end if;

    if coalesce((seat->>'wheelchair')::boolean, false)
      then want_chair := want_chair + 1;
      else want_normal := want_normal + 1;
    end if;

    total := total + case when tariff = 'reduced'
                          then fd.price_reduced_cents else fd.price_cents end;
  end loop;

  -- Every screening must have room for the whole party, or the pass would be
  -- sold with a hole in it. Checked before anything is written.
  foreach show_code in array shows loop
    select * into s from public.screenings where code = show_code;

    select
      count(*) filter (where not tk.wheelchair),
      count(*) filter (where tk.wheelchair)
      into has_normal, has_chair
    from public.tickets tk
    join public.ticket_orders o on o.id = tk.order_id
    where tk.screening = show_code
      and tk.cancelled_at is null
      and (o.status = 'issued' or (o.status = 'held' and o.holds_until > now()));

    select coalesce(sum(delta), 0) into door
    from public.screening_door_sales where screening = show_code;

    if want_normal > s.capacity - has_normal - door then
      return jsonb_build_object('ok', false, 'reason', 'sold_out',
        'screening', show_code,
        'seats_left', greatest(s.capacity - has_normal - door, 0));
    end if;
    if want_chair > s.wheelchair_spaces - has_chair then
      return jsonb_build_object('ok', false, 'reason', 'no_wheelchair_space',
        'screening', show_code,
        'wheelchair_left', greatest(s.wheelchair_spaces - has_chair, 0));
    end if;
  end loop;

  insert into public.ticket_orders (
    day, status, first_name, last_name, email,
    amount_cents, holds_until, issued_at, locale
  ) values (
    p_day,
    (case when total = 0 then 'issued' else 'held' end)::public.ticket_order_status,
    btrim(p_first_name), btrim(p_last_name), p_email::extensions.citext,
    total,
    case when total = 0 then null else now() + make_interval(mins => p_hold_mins) end,
    case when total = 0 then now() else null end,
    p_locale
  )
  returning id into order_id;

  for seat in select * from jsonb_array_elements(p_seats) loop
    tariff := lower(coalesce(nullif(btrim(seat->>'tariff'), ''), 'full'));

    loop
      pass_code := 'MFF-D-' || public.ticket_random_suffix();
      exit when not exists (
        select 1 from public.tickets where day_pass_code = pass_code);
    end loop;

    foreach show_code in array shows loop
      loop
        seat_code := 'MFF-T-' || public.ticket_random_suffix();
        exit when not exists (select 1 from public.tickets where code = seat_code);
      end loop;

      -- The money sits on the order, not here: the same pass owns one row per
      -- screening, and charging each of them would multiply the takings by the
      -- number of films in the day.
      insert into public.tickets (
        code, order_id, screening, holder_name, wheelchair,
        amount_cents, tariff, day_pass_code
      ) values (
        seat_code, order_id, show_code,
        nullif(btrim(coalesce(seat->>'holder', '')), ''),
        coalesce((seat->>'wheelchair')::boolean, false),
        0, tariff, pass_code
      );
    end loop;

    codes := codes || pass_code;
  end loop;

  return jsonb_build_object(
    'ok', true, 'order_id', order_id, 'codes', to_jsonb(codes),
    'amount_cents', total, 'free', total = 0,
    'day', p_day, 'screenings', to_jsonb(shows));
end;
$$;

-- ---------------------------------------------------------------------------
-- The door
-- ---------------------------------------------------------------------------

-- Three things can be held out at the door now, and all three end up as one
-- `tickets` row: a ticket code, a badge, or a day pass. The badge and day-pass
-- branches are the same shape — resolve to the seat booked for THIS screening,
-- refuse when there is none — so they sit side by side.
create or replace function public.ticket_check_in(
  p_code      text,
  p_screening text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  given   text := upper(btrim(coalesce(p_code, '')));
  want    text := nullif(btrim(coalesce(p_screening, '')), '');
  badge   text;
  daypass text;
  t       public.tickets%rowtype;
  o       public.ticket_orders%rowtype;
  s       public.screenings%rowtype;
  seen    integer;
begin
  if given = '' then
    return jsonb_build_object('ok', false, 'reason', 'unknown_ticket');
  end if;

  if given like 'MFF-D-%' then
    daypass := given;

    if want is null then
      return jsonb_build_object('ok', false, 'reason', 'screening_required');
    end if;

    select tk.code into given
      from public.tickets tk
      join public.ticket_orders ord on ord.id = tk.order_id
     where tk.day_pass_code = daypass
       and tk.screening = want
       and tk.cancelled_at is null
       and ord.status = 'issued'
     limit 1;

    -- Either the pass is not for this day, or it was bought after this
    -- screening had closed and so never held a seat in it.
    if given is null then
      return jsonb_build_object('ok', false, 'reason', 'day_pass_not_here',
                                'day_pass', daypass);
    end if;

  elsif given not like 'MFF-T-%' then
    badge := given;

    -- One badge can hold seats at several screenings, so without knowing which
    -- door this is there is no single seat to admit.
    if want is null then
      return jsonb_build_object('ok', false, 'reason', 'screening_required');
    end if;

    if not exists (
      select 1 from public.pass_badge_codes b
      join public.passes p on p.id = b.pass_id
      where b.code = badge and p.status = 'issued'
    ) then
      return jsonb_build_object('ok', false, 'reason', 'unknown_ticket');
    end if;

    select tk.code into given
      from public.tickets tk
      join public.ticket_orders ord on ord.id = tk.order_id
     where tk.badge_code = badge
       and tk.screening = want
       and tk.cancelled_at is null
       and ord.status = 'issued'
     limit 1;

    -- The badge is real and the person is accredited — they simply never took
    -- a seat for this screening, and the room cannot absorb them.
    if given is null then
      return jsonb_build_object('ok', false, 'reason', 'badge_not_booked',
                                'badge', badge);
    end if;
  end if;

  -- The lock is what stops one PDF forwarded on WhatsApp from admitting five
  -- people through two doors at once: the second scan waits, then sees the
  -- timestamp the first one wrote.
  select * into t from public.tickets tk where tk.code = given for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_ticket');
  end if;

  select * into o from public.ticket_orders ord where ord.id = t.order_id;
  select * into s from public.screenings sc     where sc.code = t.screening;

  -- Checked before the write, so a ticket presented at the wrong door goes home
  -- unused and still works at its own.
  if want is not null and t.screening <> want then
    return jsonb_build_object('ok', false, 'reason', 'wrong_screening',
                              'screening', t.screening,
                              'title', s.title, 'starts_at', s.starts_at);
  end if;

  if t.cancelled_at is not null or o.status <> 'issued' then
    return jsonb_build_object('ok', false, 'reason', 'not_valid');
  end if;
  if t.checked_in_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_used',
                              'at', t.checked_in_at,
                              'tariff', t.tariff,
                              'name', coalesce(t.holder_name,
                                               o.first_name || ' ' || o.last_name));
  end if;

  update public.tickets tk set checked_in_at = now() where tk.id = t.id;

  -- Counted after the write so the number on screen includes the person
  -- standing there, and reads the same on every device at the door.
  select count(*) into seen
    from public.tickets tk
   where tk.screening = t.screening
     and tk.checked_in_at is not null
     and tk.cancelled_at is null;

  return jsonb_build_object(
    'ok', true,
    'code', t.code,
    'name', coalesce(t.holder_name, o.first_name || ' ' || o.last_name),
    'screening', t.screening, 'wheelchair', t.wheelchair,
    'badge', t.badge_code, 'day_pass', t.day_pass_code,
    'tariff', t.tariff, 'checked_in', seen);
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.festival_days enable row level security;

revoke all on function public.ticket_random_suffix() from public, anon, authenticated;
revoke all on function public.ticket_reserve(text, text, text, text, jsonb, text, integer)
  from public, anon, authenticated;
revoke all on function public.ticket_day_pass_reserve(date, text, text, text, jsonb, text, integer)
  from public, anon, authenticated;
revoke all on function public.ticket_check_in(text, text) from public, anon, authenticated;

grant execute on function public.ticket_random_suffix() to service_role;
grant execute on function public.ticket_reserve(text, text, text, text, jsonb, text, integer) to service_role;
grant execute on function public.ticket_day_pass_reserve(date, text, text, text, jsonb, text, integer) to service_role;
grant execute on function public.ticket_check_in(text, text) to service_role;
grant select on public.festival_days to service_role;
