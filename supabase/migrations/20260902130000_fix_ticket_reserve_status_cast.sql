-- Fix: `ticket_reserve` could never insert an order.
--
-- The status was chosen with `case when total = 0 then 'issued' else 'held' end`.
-- Two bare literals inside a CASE resolve to `text`, and PostgreSQL refuses to
-- assign text to an enum column, so every reservation died with
-- "column status is of type ticket_order_status but expression is of type text".
-- Caught by a smoke test against the live database before any programme existed;
-- the only change below is the explicit cast on that line.

set search_path = public, extensions;

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

-- `create or replace` keeps the existing grants, but this one is `security
-- definer`: restate them rather than trust that.
revoke all on function public.ticket_reserve(text, text, text, text, jsonb, text, integer)
  from public, anon, authenticated;
grant execute on function public.ticket_reserve(text, text, text, text, jsonb, text, integer)
  to service_role;
