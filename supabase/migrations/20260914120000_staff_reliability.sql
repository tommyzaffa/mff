-- Retry an uncertain counter movement without selling the same seat twice.
-- Both the result and the ledger write commit in the same transaction.
create table public.ticket_door_requests (
  id uuid primary key,
  screening text not null,
  delta integer not null,
  tariff text not null,
  result jsonb,
  created_at timestamptz not null default now()
);
alter table public.ticket_door_requests enable row level security;
revoke all on public.ticket_door_requests from public, anon, authenticated;

create or replace function public.ticket_door_sell_once(
  p_request uuid, p_screening text, p_delta integer, p_tariff text, p_actor text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare previous public.ticket_door_requests%rowtype; outcome jsonb;
begin
  if p_request is null then
    return jsonb_build_object('ok', false, 'reason', 'bad_request_id');
  end if;
  insert into public.ticket_door_requests(id, screening, delta, tariff)
    values(p_request, p_screening, p_delta, p_tariff) on conflict (id) do nothing;
  select * into previous from public.ticket_door_requests where id=p_request for update;
  if previous.screening is distinct from p_screening or previous.delta is distinct from p_delta
     or previous.tariff is distinct from p_tariff then
    return jsonb_build_object('ok', false, 'reason', 'request_conflict');
  end if;
  if previous.result is not null then return previous.result; end if;
  outcome := public.ticket_door_sell(p_screening,p_delta,p_tariff,p_actor);
  update public.ticket_door_requests set result=outcome where id=p_request;
  return outcome;
end;
$$;
revoke all on function public.ticket_door_sell_once(uuid,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.ticket_door_sell_once(uuid,text,integer,text,text) to service_role;

-- Keep ticket, badge and day-pass entry on the same admission record.
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
  if want is null then
    return jsonb_build_object('ok', false, 'reason', 'screening_required');
  end if;

  if given = '' then
    return jsonb_build_object('ok', false, 'reason', 'unknown_ticket');
  end if;

  if given like 'MFF-D-%' then
    daypass := given;
    if not exists (select 1 from public.tickets where day_pass_code = daypass) then
      return jsonb_build_object('ok', false, 'reason', 'unknown_ticket');
    end if;
    if not exists (
      select 1 from public.tickets tk join public.ticket_orders ord on ord.id=tk.order_id
      where tk.day_pass_code=daypass and tk.cancelled_at is null and ord.status='issued'
    ) then
      return jsonb_build_object('ok', false, 'reason', 'not_valid');
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
revoke all on function public.ticket_check_in(text,text) from public, anon, authenticated;
grant execute on function public.ticket_check_in(text,text) to service_role;
