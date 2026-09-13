-- Apply before deploying the hardened Edge Functions. No secret values here.
set search_path = public, extensions;

-- This historical master was published in the site's runbook and migration.
-- Retain audit history; revoke the credential, not already-issued passes.
update public.pass_access_codes set is_active = false
where label = 'Master interno festival';

create table public.security_request_buckets (
  scope text not null,
  key text not null,
  window_start timestamptz not null,
  hits integer not null,
  expires_at timestamptz not null,
  primary key (scope, key)
);
create index security_request_buckets_expiry on public.security_request_buckets(expires_at);
alter table public.security_request_buckets enable row level security;
revoke all on public.security_request_buckets from public, anon, authenticated;

create or replace function public.security_rate_limit(
  p_scope text, p_key text, p_limit integer, p_global_limit integer, p_seconds integer
) returns boolean language plpgsql security definer set search_path = public as $$
declare w timestamptz; k text; cap integer; count_now integer;
begin
  if p_seconds < 1 or p_seconds > 3600 or p_limit < 1 or p_global_limit < 1
     or length(p_scope) > 64 or length(p_key) <> 64 then
    raise exception 'invalid rate limit';
  end if;
  w := to_timestamp(floor(extract(epoch from clock_timestamp()) / p_seconds) * p_seconds);
  -- Expiring anonymous counters; bounded cleanup keeps an old backlog cheap.
  delete from public.security_request_buckets where (scope, key) in (
    select scope, key from public.security_request_buckets
    where expires_at < clock_timestamp() limit 100
  );
  -- Always lock the global counter first. A rotating/spoofed IP cannot create
  -- unbounded rows or bypass this ceiling. Denied calls do not overflow hits.
  foreach k in array array['global', p_key] loop
    cap := case when k = 'global' then p_global_limit else p_limit end;
    insert into public.security_request_buckets as b(scope, key, window_start, hits, expires_at)
      values (p_scope, k, w, 1, w + make_interval(secs => p_seconds * 2))
      on conflict (scope, key) do update set
        hits = case when b.window_start = w then least(b.hits + 1, cap + 1) else 1 end,
        window_start = w, expires_at = w + make_interval(secs => p_seconds * 2)
      returning hits into count_now;
    if count_now > cap then return false; end if;
  end loop;
  return true;
end;
$$;
revoke all on function public.security_rate_limit(text,text,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.security_rate_limit(text,text,integer,integer,integer) to service_role;

-- Serialize claims for the same pass (pool locks alone only protected different
-- codes), and check the payment state before allocating a usable badge.
create or replace function public.pass_claim_badge_code(p_pass uuid)
returns text language plpgsql security definer set search_path = public as $$
declare p public.passes%rowtype; picked text;
begin
  select * into p from public.passes where id = p_pass for update;
  if not found then raise exception 'unknown pass'; end if;
  if p.status in ('cancelled', 'rejected') then raise exception 'pass not valid'; end if;
  if p.amount_cents > 0 and p.status not in ('paid', 'issued') then
    raise exception 'payment required';
  end if;
  if p.badge_code is not null then return p.badge_code; end if;
  update public.pass_badge_codes set pass_id = p_pass, assigned_at = now()
  where code = (select code from public.pass_badge_codes where pass_id is null
                order by code limit 1 for update skip locked)
  returning code into picked;
  if picked is null then raise exception 'badge pool exhausted'; end if;
  update public.passes set badge_code = picked where id = p_pass;
  return picked;
end;
$$;

create or replace function public.pass_issue(p_pass uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.passes%rowtype; c text;
begin
  select * into p from public.passes where id = p_pass for update;
  if not found then raise exception 'unknown pass'; end if;
  if p.status = 'issued' and p.badge_code is not null then
    return jsonb_build_object('code', p.badge_code, 'already', true);
  end if;
  c := public.pass_claim_badge_code(p_pass);
  update public.passes set status = 'issued', issued_at = now() where id = p_pass;
  return jsonb_build_object('code', c, 'already', false);
end;
$$;
revoke all on function public.pass_issue(uuid) from public, anon, authenticated;
grant execute on function public.pass_issue(uuid) to service_role;
revoke all on function public.pass_claim_badge_code(uuid) from public, anon, authenticated;
grant execute on function public.pass_claim_badge_code(uuid) to service_role;

-- Expiry and payment lock the SAME order first. Previously a payment could be
-- confirmed between the two expiry UPDATEs, leaving an issued but void ticket.
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
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.ticket_order_issue(p_id uuid, p_intent text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.ticket_orders%rowtype;
begin
  select * into o from public.ticket_orders where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'unknown_order'); end if;
  if o.status = 'issued' then return jsonb_build_object('ok', true, 'already', true); end if;
  if o.status <> 'held' then return jsonb_build_object('ok', false, 'reason', 'cancelled'); end if;
  -- Availability already excludes elapsed holds even if no sweep has run yet.
  -- Never revive one after those seats may have been sold to another party.
  if o.holds_until is null or o.holds_until <= now() then
    perform public.ticket_order_cancel(p_id);
    return jsonb_build_object('ok', false, 'reason', 'expired_hold');
  end if;
  update public.ticket_orders set status = 'issued', issued_at = now(), paid_at = now(),
    holds_until = null, stripe_payment_intent = coalesce(p_intent, stripe_payment_intent)
    where id = p_id;
  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

-- The same lock used by online reservations also protects counter adjustments.
-- An authenticated caller must still obey time/capacity rules server-side.
create or replace function public.ticket_door_sell(
  p_screening text, p_delta integer, p_tariff text, p_actor text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.screenings%rowtype; sold integer; same_tariff integer; taken integer;
begin
  if p_delta = 0 or abs(p_delta::bigint) > 20 or p_tariff not in ('full','reduced') then
    return jsonb_build_object('ok', false, 'reason', 'bad_delta');
  end if;
  select * into s from public.screenings where code = p_screening for update;
  if not found or not s.is_published or not s.is_ticketed then
    return jsonb_build_object('ok', false, 'reason', 'unknown_screening');
  end if;
  if now() < public.screening_sales_close(s) then
    return jsonb_build_object('ok', false, 'reason', 'sales_not_closed');
  end if;
  select coalesce(sum(delta),0), coalesce(sum(delta) filter (where tariff=p_tariff),0)
    into sold, same_tariff from public.screening_door_sales where screening=p_screening;
  select count(*) into taken from public.tickets t join public.ticket_orders o on o.id=t.order_id
    where t.screening=p_screening and t.cancelled_at is null and not t.wheelchair
      and (o.status='issued' or (o.status='held' and o.holds_until > now()));
  if same_tariff + p_delta < 0 or sold + taken + p_delta > s.capacity then
    return jsonb_build_object('ok', false, 'reason', 'capacity');
  end if;
  insert into public.screening_door_sales(screening,delta,tariff,actor)
    values(p_screening,p_delta,p_tariff,left(coalesce(p_actor,'cassa'),40));
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.ticket_door_sell(text,integer,text,text) from public, anon, authenticated;
grant execute on function public.ticket_door_sell(text,integer,text,text) to service_role;

-- Use cryptographic entropy and the actual alphabet length (31, not 32).
create or replace function public.ticket_random_suffix()
returns text language plpgsql volatile set search_path = public, extensions as $$
declare alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; result text := ''; b integer;
begin
  while length(result) < 8 loop
    b := get_byte(extensions.gen_random_bytes(1), 0);
    if b < 248 then result := result || substr(alphabet, (b % 31) + 1, 1); end if;
  end loop;
  return result;
end;
$$;
revoke all on function public.ticket_random_suffix() from public, anon, authenticated;
grant execute on function public.ticket_random_suffix() to service_role;

-- Receipt delivery can fail after payment has committed. Persist success so
-- Stripe retries can send the missing receipt without issuing a second ticket.
alter table public.ticket_orders add column if not exists email_sent_at timestamptz;
