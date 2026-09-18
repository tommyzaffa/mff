-- A day pass stops reserving seats — Merge Film Festival
--
-- Until now, buying a day pass silently took one seat in every ticketed
-- screening of that day. It made the pass generous and the room dishonest: a
-- holder who watched one film had still been counted against four, and those
-- seats were unsellable to anyone who would actually have sat in them.
--
-- From here a day pass behaves exactly like an accreditation badge, which is
-- the model the festival already runs and the public already understands:
--
--   buying it gives you a code, not a seat. You then reserve the screenings
--   you want, one by one, with that code — free, one seat per pass per
--   screening — and without a reservation there is no seat waiting for you.
--
-- So the pass needs somewhere to live that is not a seat. `day_passes` is that
-- place: one row per pass sold, the twin of `pass_badge_codes`. `tickets`
-- keeps `day_pass_code`, but it now means "this seat was reserved with that
-- pass" rather than "this seat was conjured when the pass was sold".
--
-- Consequences, all of them deliberate:
--   * a day pass is sold without locking or counting anything, so there is no
--     cap on how many exist — same as a badge;
--   * `ticket_reserve` gains a day-pass branch beside the badge branch, and the
--     two are mutually exclusive because the code shapes cannot collide;
--   * the door can now tell "wrong day" from "never reserved", which are two
--     different things to say to the person standing there.
--
-- Passes already sold keep the seats the old system gave them: the rows are
-- real reservations, they are counted correctly, and taking them back would
-- turn a quiet fix into a broken promise.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- The pass itself
-- ---------------------------------------------------------------------------

create table if not exists public.day_passes (
  id           uuid primary key default gen_random_uuid(),
  code         text unique not null,
  order_id     uuid not null references public.ticket_orders(id) on delete cascade,
  day          date not null references public.festival_days(day),

  holder_name  text,
  -- Declared at purchase and carried onto every seat this pass reserves, so
  -- the door knows to ask for the student card whichever screening it is.
  tariff       text not null default 'full' check (tariff in ('full', 'reduced')),

  cancelled_at timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists day_passes_order_idx on public.day_passes (order_id);
create index if not exists day_passes_day_idx   on public.day_passes (day);

-- Every pass sold under the old rules, lifted out of the seats it owns. One
-- row per code: the `distinct on` collapses the per-screening siblings.
insert into public.day_passes (code, order_id, day, holder_name, tariff, cancelled_at, created_at)
select distinct on (tk.day_pass_code)
       tk.day_pass_code,
       tk.order_id,
       o.day,
       tk.holder_name,
       case when tk.tariff = 'reduced' then 'reduced' else 'full' end,
       tk.cancelled_at,
       tk.created_at
  from public.tickets tk
  join public.ticket_orders o on o.id = tk.order_id
 where tk.day_pass_code is not null
   and o.day is not null
 order by tk.day_pass_code, tk.created_at
on conflict (code) do nothing;

-- Now that every existing value has a parent, the link can be declared. A seat
-- claiming a pass that was never sold is a bug worth refusing at write time.
do $$ begin
  alter table public.tickets
    add constraint tickets_day_pass_code_fkey
    foreign key (day_pass_code) references public.day_passes(code);
exception when duplicate_object then null; end $$;

-- The same rule the badge has, and for the same reason: one pass cannot sit in
-- two chairs at one screening. Partial on `cancelled_at` so a released seat
-- stops counting and the pass can book again.
create unique index if not exists tickets_one_per_day_pass_per_screening
  on public.tickets (screening, day_pass_code)
  where day_pass_code is not null and cancelled_at is null;

-- ---------------------------------------------------------------------------
-- Selling a day pass
-- ---------------------------------------------------------------------------

-- No locks, no counting, no seats. The only thing still worth checking is that
-- the day has something left to see: once every screening of it has closed
-- online, the pass could not be used for anything the site can still book, so
-- it is refused rather than sold as a souvenir.
--
-- `p_seats` keeps its name and shape — the form sells "one pass per person"
-- through the same widget as "one seat per person" — but `wheelchair` is now
-- meaningless here and ignored: a wheelchair space is claimed per screening,
-- when the seat is actually reserved.
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
  fd        public.festival_days%rowtype;
  seat      jsonb;
  tariff    text;
  n_seats   integer;
  total     integer := 0;
  order_id  uuid;
  pass_code text;
  codes     text[] := '{}';
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

  if not exists (
    select 1 from public.screenings sc
     where sc.is_published and sc.is_ticketed
       and (sc.starts_at at time zone 'Europe/Zurich')::date = p_day
       and now() < public.screening_sales_close(sc.*)
       and now() >= coalesce(sc.sales_open_at, '-infinity'::timestamptz)
  ) then
    return jsonb_build_object('ok', false, 'reason', 'sales_closed');
  end if;

  for seat in select * from jsonb_array_elements(p_seats) loop
    -- An accreditation already admits its holder to every screening, so a day
    -- pass on top of one would be money for nothing.
    if nullif(btrim(coalesce(seat->>'badge', '')), '') is not null then
      return jsonb_build_object('ok', false, 'reason', 'badge_on_day_pass');
    end if;

    tariff := lower(coalesce(nullif(btrim(seat->>'tariff'), ''), 'full'));
    if tariff not in ('full', 'reduced') then
      return jsonb_build_object('ok', false, 'reason', 'bad_tariff');
    end if;

    total := total + case when tariff = 'reduced'
                          then fd.price_reduced_cents else fd.price_cents end;
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
        select 1 from public.day_passes where code = pass_code);
    end loop;

    insert into public.day_passes (code, order_id, day, holder_name, tariff)
    values (pass_code, order_id, p_day,
            nullif(btrim(coalesce(seat->>'holder', '')), ''), tariff);

    codes := codes || pass_code;
  end loop;

  return jsonb_build_object(
    'ok', true, 'order_id', order_id, 'codes', to_jsonb(codes),
    'amount_cents', total, 'free', total = 0, 'day', p_day);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reserving a seat, with a badge or with a day pass
-- ---------------------------------------------------------------------------

-- The seat's `badge` field now carries either kind of credential. It is not
-- laziness: the shapes cannot collide — a day pass is 'MFF-D-XXXXXXXX' and a
-- badge 'MFF-XXXX-XXXX' — so one field on the form routes exactly, and the
-- buyer is spared a choice they would only get wrong.
--
-- Both kinds behave the same way: the seat is free, and one credential may
-- hold at most one seat per screening. They differ in what makes them valid —
-- a badge is valid for the whole festival, a day pass only for its own day —
-- and in the tariff they leave on the seat: an accredited guest owes the door
-- nothing, a reduced day pass still has to show a card.
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
  show_day    date;
  closes_at   timestamptz;
  seat        jsonb;
  cred        text;
  badge       text;
  daypass     text;
  dp          public.day_passes%rowtype;
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

  show_day  := (s.starts_at at time zone 'Europe/Zurich')::date;
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
    cred   := nullif(btrim(upper(coalesce(seat->>'badge', ''))), '');
    tariff := lower(coalesce(nullif(btrim(seat->>'tariff'), ''), 'full'));

    if tariff not in ('full', 'reduced') then
      return jsonb_build_object('ok', false, 'reason', 'bad_tariff');
    end if;

    if coalesce((seat->>'wheelchair')::boolean, false)
      then want_chair := want_chair + 1;
      else want_normal := want_normal + 1;
    end if;

    if cred is null then
      total := total + case when tariff = 'reduced'
                            then s.price_reduced_cents else s.price_cents end;

    elsif cred like 'MFF-D-%' then
      select * into dp from public.day_passes where code = cred;

      if not found or dp.cancelled_at is not null
         or not exists (select 1 from public.ticket_orders o
                         where o.id = dp.order_id and o.status = 'issued')
      then
        return jsonb_build_object('ok', false, 'reason', 'unknown_day_pass',
                                  'day_pass', cred);
      end if;

      if dp.day <> show_day then
        return jsonb_build_object('ok', false, 'reason', 'day_pass_wrong_day',
                                  'day_pass', cred, 'day', dp.day);
      end if;

      if exists (
        select 1 from public.tickets
         where screening = p_screening and day_pass_code = cred
           and cancelled_at is null
      ) then
        return jsonb_build_object('ok', false, 'reason', 'day_pass_already_used',
                                  'day_pass', cred);
      end if;

    else
      if not exists (
        select 1 from public.pass_badge_codes b
        join public.passes p on p.id = b.pass_id
        where b.code = cred and p.status = 'issued'
      ) then
        return jsonb_build_object('ok', false, 'reason', 'unknown_badge',
                                  'badge', cred);
      end if;

      if exists (
        select 1 from public.tickets
         where screening = p_screening and badge_code = cred
           and cancelled_at is null
      ) then
        return jsonb_build_object('ok', false, 'reason', 'badge_already_used',
                                  'badge', cred);
      end if;
    end if;
  end loop;

  -- Two seats on the same credential inside this one request would each pass
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

  -- A party that owes nothing is admitted immediately; an order with anything
  -- to pay is only a hold until Stripe says otherwise.
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
    cred    := nullif(btrim(upper(coalesce(seat->>'badge', ''))), '');
    tariff  := lower(coalesce(nullif(btrim(seat->>'tariff'), ''), 'full'));
    badge   := null;
    daypass := null;

    if cred is null then
      price := case when tariff = 'reduced'
                    then s.price_reduced_cents else s.price_cents end;
    elsif cred like 'MFF-D-%' then
      daypass := cred;
      price   := 0;
      -- The tariff comes from the pass, not from this form: it is what was
      -- paid for and what the door will be asked to verify.
      select dpx.tariff into tariff from public.day_passes dpx where dpx.code = cred;
    else
      badge  := cred;
      price  := 0;
      tariff := 'accredited';
    end if;

    -- 32^8 codes from an alphabet with no look-alikes, so a number read out at
    -- the door is unambiguous and cannot be guessed from a neighbour's.
    loop
      new_code := 'MFF-T-' || public.ticket_random_suffix();
      exit when not exists (select 1 from public.tickets where code = new_code);
    end loop;

    insert into public.tickets (
      code, order_id, screening, badge_code, day_pass_code, holder_name,
      wheelchair, amount_cents, tariff
    ) values (
      new_code, order_id, p_screening, badge, daypass,
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
-- The door
-- ---------------------------------------------------------------------------

-- The day-pass branch now reads the pass itself rather than inferring it from
-- the seats, which is what lets it separate the two refusals the staff need to
-- tell apart: a pass for another day is the holder's mistake, a pass for today
-- with no reservation is a rule they have to be told about.
create or replace function public.ticket_check_in(
  p_code      text,
  p_screening text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  given   text := upper(btrim(coalesce(p_code, '')));
  want    text := nullif(btrim(coalesce(p_screening, '')), '');
  badge   text;
  dp      public.day_passes%rowtype;
  t       public.tickets%rowtype;
  o       public.ticket_orders%rowtype;
  s       public.screenings%rowtype;
  seen    integer;
begin
  if want is null then
    return jsonb_build_object('ok', false, 'reason', 'screening_required');
  end if;

  if given = '' then
    return jsonb_build_object('ok', false, 'reason', 'unknown_ticket');
  end if;

  if given like 'MFF-D-%' then
    select * into dp from public.day_passes where code = given;
    if not found then
      return jsonb_build_object('ok', false, 'reason', 'unknown_ticket');
    end if;

    if dp.cancelled_at is not null
       or not exists (select 1 from public.ticket_orders ord
                       where ord.id = dp.order_id and ord.status = 'issued')
    then
      return jsonb_build_object('ok', false, 'reason', 'not_valid');
    end if;

    select tk.code into given
      from public.tickets tk
      join public.ticket_orders ord on ord.id = tk.order_id
     where tk.day_pass_code = dp.code
       and tk.screening = want
       and tk.cancelled_at is null
       and ord.status = 'issued'
     limit 1;

    if given is null then
      select * into s from public.screenings sc where sc.code = want;

      if s.starts_at is null
         or (s.starts_at at time zone 'Europe/Zurich')::date <> dp.day then
        return jsonb_build_object('ok', false, 'reason', 'day_pass_not_here',
                                  'day_pass', dp.code, 'day', dp.day);
      end if;

      -- Right day, no reservation. The pass is real and paid for; it simply
      -- never took a seat here, and the room cannot absorb it.
      return jsonb_build_object('ok', false, 'reason', 'day_pass_not_booked',
                                'day_pass', dp.code, 'tariff', dp.tariff);
    end if;

  elsif given not like 'MFF-T-%' then
    badge := given;

    -- Resolve only the reservation for the selected screening.
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
  if t.screening <> want then
    return jsonb_build_object('ok', false, 'reason', 'wrong_screening',
                              'screening', t.screening,
                              'title', s.title, 'starts_at', s.starts_at);
  end if;

  if t.badge_code is not null and not exists (
    select 1 from public.pass_badge_codes b join public.passes p on p.id=b.pass_id
    where b.code=t.badge_code and p.status='issued'
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_valid');
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
-- Giving a day pass back
-- ---------------------------------------------------------------------------

-- A day pass now survives its own order's seats, so cancelling has to reach it
-- explicitly: otherwise an abandoned checkout would leave a live credential
-- behind that its owner never paid for.
create or replace function public.ticket_order_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.ticket_orders
     set status = 'cancelled', holds_until = null
   where id = p_id and status <> 'issued';

  if not exists (select 1 from public.ticket_orders o
                  where o.id = p_id and o.status = 'cancelled') then
    return;
  end if;

  update public.tickets
     set cancelled_at = now()
   where order_id = p_id and cancelled_at is null;

  update public.day_passes
     set cancelled_at = now()
   where order_id = p_id and cancelled_at is null;
end;
$$;

create or replace function public.ticket_expire_holds()
returns integer language plpgsql security definer set search_path = public as $$
declare o record; n integer := 0;
begin
  for o in select id from public.ticket_orders
    where status = 'held' and holds_until < now() order by id for update skip locked
  loop
    update public.ticket_orders set status = 'cancelled', holds_until = null where id = o.id;
    update public.tickets set cancelled_at = now()
      where order_id = o.id and cancelled_at is null;
    update public.day_passes set cancelled_at = now()
      where order_id = o.id and cancelled_at is null;
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.day_passes enable row level security;
revoke all on public.day_passes from public, anon, authenticated;
grant select, insert, update on public.day_passes to service_role;

revoke all on function public.ticket_reserve(text, text, text, text, jsonb, text, integer)
  from public, anon, authenticated;
revoke all on function public.ticket_day_pass_reserve(date, text, text, text, jsonb, text, integer)
  from public, anon, authenticated;
revoke all on function public.ticket_check_in(text, text) from public, anon, authenticated;
revoke all on function public.ticket_order_cancel(uuid) from public, anon, authenticated;
revoke all on function public.ticket_expire_holds() from public, anon, authenticated;

grant execute on function public.ticket_reserve(text, text, text, text, jsonb, text, integer) to service_role;
grant execute on function public.ticket_day_pass_reserve(date, text, text, text, jsonb, text, integer) to service_role;
grant execute on function public.ticket_check_in(text, text) to service_role;
grant execute on function public.ticket_order_cancel(uuid) to service_role;
grant execute on function public.ticket_expire_holds() to service_role;
