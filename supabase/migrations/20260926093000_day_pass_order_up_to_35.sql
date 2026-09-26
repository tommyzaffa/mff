-- Una giornaliera non e' un posto in sala: e' un codice che ammette il suo
-- intestatario a tutte le proiezioni del giorno, e i posti se li prenota dopo,
-- una per una. Il tetto di 10 per ordine era quello dei posti di una singola
-- proiezione, copiato dove non serviva: una scuola che ne compra una per
-- studente sbatteva contro 'bad_seat_count' a dieci. Ora sono 35.
--
-- Cambia SOLO quel numero: il resto della funzione e' identico alla versione di
-- 20260918160000_ticket_access_codes.sql, ricopiata perche' un `create or
-- replace` deve riscrivere il corpo per intero.
--
-- I tetti sono quattro e devono restare d'accordo: MAX_DAY_PASSES in
-- assets/js/tickets.js (nasconde "aggiungi"), MAX_DAY_PASSES in
-- supabase/functions/ticket-reserve (rifiuta con 'too_many_seats') e questo.
-- Il quarto, MAX_SEATS, resta a 10 e vale per i posti di una proiezione.

set search_path = public, extensions;

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
  -- 35 e non 10 come per i posti di una proiezione: una giornaliera e' un
  -- codice, non una poltrona, e chi ne compra molte in un colpo solo e' una
  -- classe che ne prende una per studente. La capienza della sala resta
  -- protetta dove conta davvero, cioe' quando il pass prenota i suoi posti.
  if n_seats < 1 or n_seats > 35 then
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

revoke all on function public.ticket_day_pass_reserve(date, text, text, text, jsonb, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.ticket_day_pass_reserve(date, text, text, text, jsonb, text, integer, text) to service_role;
