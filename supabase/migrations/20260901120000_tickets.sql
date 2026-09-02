-- Seat reservations — Merge Film Festival
--
-- One room (Lux art house, 273 seats + 2 wheelchair spaces) and two sales
-- channels that must never oversell it. They are kept apart in time rather than
-- coordinated:
--
--   * the site sells until 60 minutes before a screening starts;
--   * the box office sells only after that, from whatever is left.
--
-- Because the two windows do not overlap, there is no distributed counter to
-- keep in sync and no way for the cinema's till and this database to disagree
-- about the same seat. The door staff read a number off a page; they never have
-- to enter one for the arithmetic to work.
--
-- One purchase can hold several seats, and each seat is independent: a party of
-- three can be two accredited holders — who pay nothing, one seat per badge —
-- and one paying guest, settled in a single checkout. So an order is the unit
-- of payment and a ticket is the unit of admission, with its own code, because
-- the three of them may well arrive at the door separately.
--
-- Reuses `public.screenings` from the audience award rather than introducing a
-- second schedule that would drift out of step with it. Careful: that table
-- already had `opens_at`/`closes_at`, which are the *voting* window. Everything
-- to do with selling is named `sales_*`.
--
-- Like the passes schema and unlike the voting one, the browser never touches
-- these tables directly: RLS is on with no policy, so only the edge functions
-- (service role) get in.

set search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- The room
-- ---------------------------------------------------------------------------

-- Seats are numbered on the floor plan but not assigned: a ticket is a place in
-- the room, and people sit where they like. So capacity is a single number to
-- count down, not a map to allocate — which is also why two people checking out
-- at the same instant can never be handed "the same seat".
--
-- `wheelchair_spaces` is counted separately because those two places cannot be
-- taken by someone who does not need them, and someone who does need one must
-- not be told the screening is full when a space is free.
alter table public.screenings
  add column if not exists is_ticketed       boolean     not null default true,
  add column if not exists capacity          integer     not null default 273
    check (capacity >= 0),
  add column if not exists wheelchair_spaces integer     not null default 2
    check (wheelchair_spaces >= 0),
  add column if not exists price_cents       integer     not null default 0
    check (price_cents >= 0),
  -- Left null for the ordinary case so the rule lives in one place; set it by
  -- hand only for a screening that has to close earlier or later than usual.
  add column if not exists sales_close_at    timestamptz,
  add column if not exists sales_open_at     timestamptz;

comment on column public.screenings.sales_close_at is
  'Online sales stop here. Null means the standing rule: 60 minutes before starts_at.';

-- The one place that decides when the site may still sell. Everything else —
-- the reservation RPC, the public page, the door page — asks this, so the rule
-- cannot be implemented twice and drift.
create or replace function public.screening_sales_close(s public.screenings)
returns timestamptz language sql immutable as $$
  select coalesce(s.sales_close_at, s.starts_at - interval '60 minutes');
$$;

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------

-- `held` is a set of seats taken out of the pool while someone is on the Stripe
-- page. It is not a sale yet and it expires on its own, so an abandoned
-- checkout gives the seats back instead of burying them until the screening.
do $$ begin
  create type public.ticket_order_status as enum ('held', 'issued', 'cancelled');
exception when duplicate_object then null; end $$;

-- One screening per order. A cart spanning several films would have to lock
-- several screenings at once, and the festival sells one film at a time.
create table if not exists public.ticket_orders (
  id            uuid primary key default gen_random_uuid(),
  screening     text not null references public.screenings(code) on delete cascade,
  status        public.ticket_order_status not null default 'held',

  first_name    text not null check (length(btrim(first_name)) between 1 and 60),
  last_name     text not null check (length(btrim(last_name))  between 1 and 60),
  email         extensions.citext not null,

  amount_cents  integer not null default 0 check (amount_cents >= 0),
  stripe_session_id     text unique,
  stripe_payment_intent text,
  paid_at       timestamptz,

  -- A held order is only really held until this moment. Null once issued.
  holds_until   timestamptz,
  issued_at     timestamptz,

  locale        text not null default 'it' check (locale in ('it','en','fr','de')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists ticket_orders_screening_idx
  on public.ticket_orders (screening, status);
create index if not exists ticket_orders_email_idx on public.ticket_orders (email);

-- ---------------------------------------------------------------------------
-- Tickets
-- ---------------------------------------------------------------------------

-- One row per seat, one code per row, because the people on an order arrive
-- separately and each has to be admitted on their own.
--
-- There is deliberately no status here: whether a seat is live is the order's
-- business, and duplicating it would give two answers that could disagree. The
-- single exception is `cancelled_at`, which is also stamped on every ticket of
-- a cancelled order so the one-badge-per-screening index below stays honest.
create table if not exists public.tickets (
  id            uuid primary key default gen_random_uuid(),
  code          text unique not null,
  order_id      uuid not null references public.ticket_orders(id) on delete cascade,
  screening     text not null references public.screenings(code) on delete cascade,

  -- An accredited holder reserves instead of buying, so the badge number is the
  -- proof of entitlement and the thing counted one-per-screening against.
  badge_code    text references public.pass_badge_codes(code),
  holder_name   text,             -- printed when the seat is not the buyer's own
  wheelchair    boolean not null default false,
  amount_cents  integer not null default 0 check (amount_cents >= 0),

  checked_in_at timestamptz,
  cancelled_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists tickets_screening_idx on public.tickets (screening);
create index if not exists tickets_order_idx     on public.tickets (order_id);
create index if not exists tickets_badge_idx     on public.tickets (badge_code);

-- The rule the festival asked for: one badge, one seat, per screening. It also
-- catches the same badge listed twice inside a single order, which is why the
-- RPC below does not need to de-duplicate its own input to stay correct.
create unique index if not exists tickets_one_per_badge_per_screening
  on public.tickets (screening, badge_code)
  where badge_code is not null and cancelled_at is null;

create or replace function public.ticket_order_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists ticket_orders_touch on public.ticket_orders;
create trigger ticket_orders_touch before update on public.ticket_orders
  for each row execute function public.ticket_order_touch_updated_at();

-- ---------------------------------------------------------------------------
-- What the box office sold
-- ---------------------------------------------------------------------------

-- A ledger of movements, not a total. Two people tapping "+1" at the same
-- moment each append a row and both sales survive; if the page wrote a total
-- instead, the second write would silently erase the first. It also means a
-- mistaken tap is undone by appending -1, and the history stays readable.
create table if not exists public.screening_door_sales (
  id         bigserial primary key,
  screening  text not null references public.screenings(code) on delete cascade,
  delta      integer not null check (delta <> 0 and abs(delta) <= 50),
  actor      text,
  created_at timestamptz not null default now()
);

create index if not exists door_sales_screening_idx
  on public.screening_door_sales (screening, created_at);

-- ---------------------------------------------------------------------------
-- Seats left
-- ---------------------------------------------------------------------------

-- One definition of "taken", used by the reservation RPC, the public page and
-- the door page alike. A held seat counts only while its hold is still alive.
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
                                                           as wheelchair_left
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
  select coalesce(sum(delta), 0) as door_sold
  from public.screening_door_sales ds
  where ds.screening = s.code
) d on true;

-- ---------------------------------------------------------------------------
-- The operation that must not race
-- ---------------------------------------------------------------------------

-- Takes the screening's row lock first, so every concurrent attempt on the same
-- screening is serialised and the count cannot be read stale. Two parties going
-- for the last two seats get one order and one honest "sold out" rather than
-- four tickets and two people standing.
--
-- `p_seats` is a json array, one object per seat:
--     [{"badge": "MFF-ABCD-EFGH"}, {"badge": null, "wheelchair": true}, ...]
-- A seat with a valid badge is free; a seat without one is charged. That is how
-- a party of three pays for exactly the one of them who is not accredited.
--
-- Returns {ok:true, ...} or {ok:false, reason}, where reason is a stable key
-- the page turns into a translated sentence.
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
    badge := nullif(btrim(upper(coalesce(seat->>'badge', ''))), '');

    if coalesce((seat->>'wheelchair')::boolean, false)
      then want_chair := want_chair + 1;
      else want_normal := want_normal + 1;
    end if;

    if badge is null then
      total := total + s.price_cents;
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
    badge := nullif(btrim(upper(coalesce(seat->>'badge', ''))), '');

    -- 32^8 codes from an alphabet with no look-alikes, so a number read out at
    -- the door is unambiguous and cannot be guessed from a neighbour's.
    loop
      new_code := 'MFF-T-' ||
        (select string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
                                  1 + floor(random() * 32)::int, 1), '')
           from generate_series(1, 8));
      exit when not exists (select 1 from public.tickets where code = new_code);
    end loop;

    insert into public.tickets (
      code, order_id, screening, badge_code, holder_name, wheelchair, amount_cents
    ) values (
      new_code, order_id, p_screening, badge,
      nullif(btrim(coalesce(seat->>'holder', '')), ''),
      coalesce((seat->>'wheelchair')::boolean, false),
      case when badge is null then s.price_cents else 0 end
    );

    codes := codes || new_code;
  end loop;

  return jsonb_build_object(
    'ok', true, 'order_id', order_id, 'codes', to_jsonb(codes),
    'amount_cents', total, 'free', total = 0,
    'seats_left', s.capacity - has_normal - door - want_normal);
end;
$$;

-- Turns a hold into a sale. Idempotent, so a Stripe webhook delivered twice
-- does not issue the order twice or move `issued_at`.
create or replace function public.ticket_order_issue(p_id uuid, p_intent text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare row public.ticket_orders%rowtype;
begin
  select * into row from public.ticket_orders where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_order');
  end if;
  if row.status = 'issued' then
    return jsonb_build_object('ok', true, 'already', true);
  end if;
  if row.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'reason', 'cancelled');
  end if;

  update public.ticket_orders
     set status = 'issued', issued_at = now(), paid_at = now(),
         holds_until = null,
         stripe_payment_intent = coalesce(p_intent, stripe_payment_intent)
   where id = p_id;

  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

-- Gives the seats back: an expired Stripe session, or an order withdrawn. The
-- rows are kept and stamped rather than deleted, so the history survives and
-- the one-badge-per-screening index stops counting them.
create or replace function public.ticket_order_cancel(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.ticket_orders
     set status = 'cancelled', holds_until = null
   where id = p_id and status <> 'issued';

  update public.tickets
     set cancelled_at = now()
   where order_id = p_id and cancelled_at is null
     and exists (select 1 from public.ticket_orders o
                  where o.id = p_id and o.status = 'cancelled');
end;
$$;

-- Marks a ticket used at the door. Refuses the second scan, which is what stops
-- one PDF forwarded on WhatsApp from admitting five people.
create or replace function public.ticket_check_in(p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare t public.tickets%rowtype; o public.ticket_orders%rowtype;
begin
  select * into t from public.tickets
   where code = upper(btrim(p_code)) for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_ticket');
  end if;

  select * into o from public.ticket_orders where id = t.order_id;

  if t.cancelled_at is not null or o.status <> 'issued' then
    return jsonb_build_object('ok', false, 'reason', 'not_valid');
  end if;
  if t.checked_in_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_used',
                              'at', t.checked_in_at);
  end if;

  update public.tickets set checked_in_at = now() where id = t.id;

  return jsonb_build_object(
    'ok', true,
    'name', coalesce(t.holder_name, o.first_name || ' ' || o.last_name),
    'screening', t.screening, 'wheelchair', t.wheelchair,
    'badge', t.badge_code);
end;
$$;

-- Sweeps holds whose Stripe session came to nothing. Cheap enough to call at
-- the top of every availability read, so seats come back without a cron job.
create or replace function public.ticket_expire_holds()
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.tickets t
     set cancelled_at = now()
    from public.ticket_orders o
   where o.id = t.order_id and t.cancelled_at is null
     and o.status = 'held' and o.holds_until is not null and o.holds_until < now();

  update public.ticket_orders
     set status = 'cancelled', holds_until = null
   where status = 'held' and holds_until is not null and holds_until < now();

  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

-- Orders carry names and emails, so the anon key gets nothing at all: on, with
-- no policy, denies every operation. The edge functions use the service role.
alter table public.ticket_orders        enable row level security;
alter table public.tickets              enable row level security;
alter table public.screening_door_sales enable row level security;

revoke all on public.screening_availability from anon, authenticated;

-- These are `security definer`, so PostgreSQL's default grant to PUBLIC would
-- hand the browser a way around the RLS above — the same trap the pass RPCs
-- were caught by. They are only ever called by the edge functions.
revoke all on function public.ticket_reserve(text, text, text, text, jsonb, text, integer)
  from public, anon, authenticated;
revoke all on function public.ticket_order_issue(uuid, text)  from public, anon, authenticated;
revoke all on function public.ticket_order_cancel(uuid)       from public, anon, authenticated;
revoke all on function public.ticket_check_in(text)           from public, anon, authenticated;
revoke all on function public.ticket_expire_holds()           from public, anon, authenticated;

grant execute on function public.ticket_reserve(text, text, text, text, jsonb, text, integer) to service_role;
grant execute on function public.ticket_order_issue(uuid, text) to service_role;
grant execute on function public.ticket_order_cancel(uuid)      to service_role;
grant execute on function public.ticket_check_in(text)          to service_role;
grant execute on function public.ticket_expire_holds()          to service_role;
grant select on public.screening_availability                   to service_role;

-- Not security definer and not secret, but the pass lock-down migration set
-- default privileges to revoke EXECUTE from everyone, so without this the view
-- above breaks the moment it is read by anything other than its owner.
grant execute on function public.screening_sales_close(public.screenings) to service_role;
