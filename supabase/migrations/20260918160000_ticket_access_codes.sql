-- Invitation codes for seats and day passes — Merge Film Festival
--
-- The festival already hands out passes without money changing hands: the
-- gestionale mints a `pass_access_codes` row, the guest types it on the public
-- form, and the pass comes out free. Seats and day passes had no equivalent,
-- so a school, a sponsor or a guest who needed twenty seats at one screening
-- had to be let in by hand at the door — invisible to the room count and to
-- everyone planning around it.
--
-- `ticket_access_codes` is that equivalent, deliberately shaped like its older
-- sibling: a code, who it is for, how many times it may be used, and a switch
-- to turn it off. What it unlocks is narrower, because a seat is narrower than
-- a pass:
--
--   scope 'screening' — one free seat. Pinned to one screening, or left open
--                       to any ticketed screening if `screening` is null.
--   scope 'day'       — one free day pass for that day. The pass then books
--                       its own seats, free, exactly as a bought one does.
--
-- Two things are worth saying about the design, because both were choices.
--
-- First, the code is spent at the ORDER, not at the seat. The booking form
-- already has a per-seat field, but that field means "this person already has
-- a credential"; an invitation means "this booking is on us". Putting it at the
-- top of the form keeps those two ideas apart on screen and, underneath, means
-- one party of six spends six uses of one code rather than needing six codes.
--
-- Second, `uses` is counted, never incremented. A held order that is never paid
-- for, a cancelled order, a released seat — each of those must hand the use
-- back, and a counter would need every one of those paths to remember. The
-- count is taken under `for update` on the code row, so two people racing for
-- the last seat on a code still get one yes and one no.
--
-- An invitation code can never begin with `MFF-`, which is what keeps it from
-- colliding with the badge and day-pass codes the same booking form accepts.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- The code
-- ---------------------------------------------------------------------------

create table if not exists public.ticket_access_codes (
  code       text primary key
             check (code ~ '^[A-Z0-9][A-Z0-9-]{2,31}$' and code !~ '^MFF-'),
  label      text not null,

  scope      text not null check (scope in ('screening', 'day')),
  -- Null with scope 'screening' means "any ticketed screening"; a day pass is
  -- for a named day by definition, so there `day` is required.
  screening  text references public.screenings(code) on update cascade,
  day        date references public.festival_days(day) on update cascade,

  -- Null is unlimited, like `pass_access_codes.max_uses`.
  max_uses   integer check (max_uses is null or max_uses >= 1),
  is_active  boolean not null default true,
  note       text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),

  constraint ticket_access_codes_scope_fields check (
    (scope = 'screening' and day is null) or
    (scope = 'day' and screening is null and day is not null)
  )
);

alter table public.ticket_access_codes enable row level security;

-- What the code paid for. Nullable, because almost nothing is bought this way.
alter table public.tickets
  add column if not exists access_code text references public.ticket_access_codes(code);
alter table public.day_passes
  add column if not exists access_code text references public.ticket_access_codes(code);

create index if not exists tickets_access_code_idx
  on public.tickets (access_code) where access_code is not null;
create index if not exists day_passes_access_code_idx
  on public.day_passes (access_code) where access_code is not null;

-- ---------------------------------------------------------------------------
-- Counting and claiming
-- ---------------------------------------------------------------------------

-- A use is a live thing the code paid for. An expired hold or a cancelled order
-- is not live, so its use comes back on its own.
create or replace function public.ticket_access_code_uses(p_code text)
returns integer language sql stable security definer set search_path = public as $$
  select (
    (select count(*) from public.tickets tk
       join public.ticket_orders o on o.id = tk.order_id
      where tk.access_code = p_code
        and tk.cancelled_at is null
        and (o.status = 'issued'
             or (o.status = 'held' and o.holds_until > now())))
  + (select count(*) from public.day_passes dp
       join public.ticket_orders o on o.id = dp.order_id
      where dp.access_code = p_code
        and dp.cancelled_at is null
        and (o.status = 'issued'
             or (o.status = 'held' and o.holds_until > now())))
  )::integer;
$$;

-- Validates a code against what is being booked and reserves `p_want` of its
-- remaining uses for the caller's transaction. It does not write: the `for
-- update` lock is what holds the claim, and it is released when the caller
-- commits the rows that make the use real.
create or replace function public.ticket_access_code_claim(
  p_code      text,
  p_want      integer,
  p_screening text default null,
  p_day       date default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c    public.ticket_access_codes%rowtype;
  used integer;
begin
  select * into c from public.ticket_access_codes
   where code = p_code for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_invite');
  end if;
  if not c.is_active then
    return jsonb_build_object('ok', false, 'reason', 'invite_inactive');
  end if;
  if c.expires_at is not null and now() >= c.expires_at then
    return jsonb_build_object('ok', false, 'reason', 'invite_expired');
  end if;

  if p_day is not null then
    if c.scope <> 'day' then
      return jsonb_build_object('ok', false, 'reason', 'invite_not_for_day');
    end if;
    if c.day <> p_day then
      return jsonb_build_object('ok', false, 'reason', 'invite_wrong_day',
                                'day', c.day);
    end if;
  else
    if c.scope <> 'screening' then
      return jsonb_build_object('ok', false, 'reason', 'invite_not_for_screening');
    end if;
    if c.screening is not null and c.screening is distinct from p_screening then
      return jsonb_build_object('ok', false, 'reason', 'invite_wrong_screening',
                                'screening', c.screening);
    end if;
  end if;

  used := public.ticket_access_code_uses(p_code);
  if c.max_uses is not null and used + p_want > c.max_uses then
    return jsonb_build_object('ok', false, 'reason', 'invite_used_up',
                              'left', greatest(c.max_uses - used, 0));
  end if;

  return jsonb_build_object(
    'ok', true,
    'left', case when c.max_uses is null then null else c.max_uses - used - p_want end);
end;
$$;

-- What the gestionale reads: the code plus the two things a person deciding
-- whether to issue another one needs, which are how many are gone and what the
-- screening is actually called.
create or replace view public.ticket_access_code_list as
select c.code,
       c.label,
       c.scope,
       c.screening,
       c.day,
       c.max_uses,
       c.is_active,
       c.note,
       c.expires_at,
       c.created_at,
       public.ticket_access_code_uses(c.code) as uses,
       s.title     as screening_title,
       s.starts_at as screening_starts_at
  from public.ticket_access_codes c
  left join public.screenings s on s.code = c.screening;

-- ---------------------------------------------------------------------------
-- Spending it: a seat
-- ---------------------------------------------------------------------------

-- The signature gains `p_access_code`. It has to be dropped and recreated
-- rather than replaced: adding a defaulted parameter makes a second overload,
-- and every existing seven-argument call would then be ambiguous.
drop function if exists public.ticket_reserve(text, text, text, text, jsonb, text, integer);

create or replace function public.ticket_reserve(
  p_screening   text,
  p_first_name  text,
  p_last_name   text,
  p_email       text,
  p_seats       jsonb,
  p_locale      text default 'it',
  p_hold_mins   integer default 20,
  p_access_code text default null
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
  invite      text := nullif(btrim(upper(coalesce(p_access_code, ''))), '');
  claim       jsonb;
  want_free   integer := 0;
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
      -- An invitation pays for exactly the seats nobody else is paying for:
      -- a badge or a day pass already makes its own seat free, and charging
      -- the code for those would spend it on nothing.
      if invite is not null then
        want_free := want_free + 1;
      else
        total := total + case when tariff = 'reduced'
                              then s.price_reduced_cents else s.price_cents end;
      end if;

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

  if invite is not null then
    if want_free = 0 then
      -- Every seat in the party already has its own credential. Taking the
      -- code would cost a use and buy nothing, so say so instead.
      return jsonb_build_object('ok', false, 'reason', 'invite_not_needed');
    end if;
    claim := public.ticket_access_code_claim(invite, want_free, p_screening, null);
    if claim->>'ok' <> 'true' then
      return claim || jsonb_build_object('invite', invite);
    end if;
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
      price := case when invite is not null then 0
                    when tariff = 'reduced' then s.price_reduced_cents
                    else s.price_cents end;
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
      code, order_id, screening, badge_code, day_pass_code, access_code,
      holder_name, wheelchair, amount_cents, tariff
    ) values (
      new_code, order_id, p_screening, badge, daypass,
      case when cred is null then invite else null end,
      nullif(btrim(coalesce(seat->>'holder', '')), ''),
      coalesce((seat->>'wheelchair')::boolean, false),
      price, tariff
    );

    codes := codes || new_code;
  end loop;

  return jsonb_build_object(
    'ok', true, 'order_id', order_id, 'codes', to_jsonb(codes),
    'amount_cents', total, 'free', total = 0,
    'invited', invite is not null,
    'seats_left', s.capacity - has_normal - door - want_normal);
end;
$$;

-- ---------------------------------------------------------------------------
-- Spending it: a day pass
-- ---------------------------------------------------------------------------

drop function if exists public.ticket_day_pass_reserve(date, text, text, text, jsonb, text, integer);

create or replace function public.ticket_day_pass_reserve(
  p_day         date,
  p_first_name  text,
  p_last_name   text,
  p_email       text,
  p_seats       jsonb,
  p_locale      text default 'it',
  p_hold_mins   integer default 20,
  p_access_code text default null
)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  fd        public.festival_days%rowtype;
  seat      jsonb;
  tariff    text;
  n_seats   integer;
  total     integer := 0;
  invite    text := nullif(btrim(upper(coalesce(p_access_code, ''))), '');
  claim     jsonb;
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

  if invite is not null then
    claim := public.ticket_access_code_claim(invite, n_seats, null, p_day);
    if claim->>'ok' <> 'true' then
      return claim || jsonb_build_object('invite', invite);
    end if;
    total := 0;
  end if;

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

    insert into public.day_passes (code, order_id, day, holder_name, tariff, access_code)
    values (pass_code, order_id, p_day,
            nullif(btrim(coalesce(seat->>'holder', '')), ''), tariff, invite);

    codes := codes || pass_code;
  end loop;

  return jsonb_build_object(
    'ok', true, 'order_id', order_id, 'codes', to_jsonb(codes),
    'amount_cents', total, 'free', total = 0,
    'invited', invite is not null, 'day', p_day);
end;
$$;

-- ---------------------------------------------------------------------------
-- Who may call any of this
-- ---------------------------------------------------------------------------

-- All four are `security definer`, and PostgreSQL grants EXECUTE to PUBLIC on
-- a newly created function. Dropping and recreating the two reserve functions
-- threw away the revokes they were given when they were first written, so both
-- have to be said again here — leaving them out would hand the browser a way
-- straight past the row-level security on `tickets`.
revoke all on function public.ticket_reserve(text, text, text, text, jsonb, text, integer, text)
  from public, anon, authenticated;
revoke all on function public.ticket_day_pass_reserve(date, text, text, text, jsonb, text, integer, text)
  from public, anon, authenticated;
revoke all on function public.ticket_access_code_uses(text)  from public, anon, authenticated;
revoke all on function public.ticket_access_code_claim(text, integer, text, date)
  from public, anon, authenticated;
revoke all on public.ticket_access_codes     from anon, authenticated;
revoke all on public.ticket_access_code_list from anon, authenticated;

grant execute on function public.ticket_reserve(text, text, text, text, jsonb, text, integer, text) to service_role;
grant execute on function public.ticket_day_pass_reserve(date, text, text, text, jsonb, text, integer, text) to service_role;
grant execute on function public.ticket_access_code_uses(text) to service_role;
grant execute on function public.ticket_access_code_claim(text, integer, text, date) to service_role;
grant select, insert, update on public.ticket_access_codes to service_role;
grant select on public.ticket_access_code_list to service_role;
