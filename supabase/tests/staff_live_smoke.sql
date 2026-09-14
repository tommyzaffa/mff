-- Optional live smoke test. All fixtures and admissions are rolled back.
-- Run only against the intended festival project; never replace ROLLBACK with COMMIT.
begin;
set local statement_timeout = '15s';
set local lock_timeout = '3s';
do $$
declare
  badge_result jsonb;
  pass_id uuid;
  badge text;
  single_order jsonb;
  badge_order jsonb;
  daily_order jsonb;
  verdict jsonb;
  test_day date := current_date + 10;
begin
  insert into public.screenings(code,title,starts_at,opens_at,closes_at,is_published,is_ticketed,capacity,wheelchair_spaces,price_cents,price_reduced_cents) values
    ('audit-staff-a','Temporary staff audit A',test_day+time '12:00',test_day+time '13:00',test_day+time '14:00',true,true,10,2,1500,1000),
    ('audit-staff-b','Temporary staff audit B',test_day+time '16:00',test_day+time '17:00',test_day+time '18:00',true,true,10,2,1500,1000),
    ('audit-staff-till','Temporary staff audit till',now()+interval '30 minutes',now()+interval '1 hour',now()+interval '2 hours',true,true,2,2,1500,1000);
  insert into public.festival_days(day,code,is_on_sale,price_cents,price_reduced_cents)
    values(test_day,'audit-staff-day',true,3000,2500);

  single_order := public.ticket_reserve('audit-staff-a','Temporary','Audit','staff-audit@example.invalid','[{"tariff":"full"}]'::jsonb,'it',20);
  if single_order->>'ok' <> 'true' then raise exception 'Single reservation failed: %', single_order; end if;
  verdict := public.ticket_check_in(single_order->'codes'->>0,'audit-staff-a');
  if verdict->>'reason' <> 'not_valid' then raise exception 'Unpaid ticket accepted'; end if;
  perform public.ticket_order_issue((single_order->>'order_id')::uuid);
  verdict := public.ticket_check_in(single_order->'codes'->>0,'audit-staff-b');
  if verdict->>'reason' <> 'wrong_screening' then raise exception 'Wrong film not refused'; end if;
  verdict := public.ticket_check_in(single_order->'codes'->>0,'audit-staff-a');
  if verdict->>'ok' <> 'true' then raise exception 'Correct film refused'; end if;
  verdict := public.ticket_check_in(single_order->'codes'->>0,'audit-staff-a');
  if verdict->>'reason' <> 'already_used' then raise exception 'Duplicate admitted'; end if;

  insert into public.passes(type,first_name,last_name,email,amount_cents,status)
    values('guest','Temporary','Audit','staff-audit@example.invalid',4000,'paid') returning id into pass_id;
  badge_result := public.pass_issue(pass_id);
  badge := badge_result->>'code';
  if badge is null then raise exception 'Badge issuance failed'; end if;
  verdict := public.ticket_check_in(badge,'audit-staff-a');
  if verdict->>'reason' <> 'badge_not_booked' then raise exception 'Unbooked badge accepted'; end if;
  badge_order := public.ticket_reserve('audit-staff-a','Temporary','Audit','staff-audit@example.invalid',jsonb_build_array(jsonb_build_object('badge',badge)),'it',20);
  if badge_order->>'ok' <> 'true' then raise exception 'Badge booking failed'; end if;
  verdict := public.ticket_check_in(badge,'audit-staff-a');
  if verdict->>'ok' <> 'true' then raise exception 'Booked badge refused'; end if;
  verdict := public.ticket_check_in(badge_order->'codes'->>0,'audit-staff-a');
  if verdict->>'reason' <> 'already_used' then raise exception 'Badge ticket double admitted'; end if;

  daily_order := public.ticket_day_pass_reserve(test_day,'Temporary','Audit','staff-audit@example.invalid','[{"tariff":"reduced"}]'::jsonb,'it',20);
  if daily_order->>'ok' <> 'true' then raise exception 'Day reservation failed: %', daily_order; end if;
  perform public.ticket_order_issue((daily_order->>'order_id')::uuid);
  verdict := public.ticket_check_in(daily_order->'codes'->>0,'audit-staff-till');
  if verdict->>'reason' <> 'day_pass_not_here' then raise exception 'Wrong day admitted'; end if;
  verdict := public.ticket_check_in(daily_order->'codes'->>0,'audit-staff-a');
  if verdict->>'ok' <> 'true' or verdict->>'tariff' <> 'reduced' then raise exception 'Day pass film A failed'; end if;
  verdict := public.ticket_check_in(daily_order->'codes'->>0,'audit-staff-a');
  if verdict->>'reason' <> 'already_used' then raise exception 'Day pass duplicate admitted'; end if;
  verdict := public.ticket_check_in(daily_order->'codes'->>0,'audit-staff-b');
  if verdict->>'ok' <> 'true' then raise exception 'Day pass film B refused'; end if;

  verdict := public.ticket_door_sell('audit-staff-a',1,'full','audit');
  if verdict->>'reason' <> 'sales_not_closed' then raise exception 'Counter opened early'; end if;
  verdict := public.ticket_door_sell('audit-staff-till',2,'full','audit');
  if verdict->>'ok' <> 'true' then raise exception 'Counter sale failed'; end if;
  verdict := public.ticket_door_sell('audit-staff-till',1,'reduced','audit');
  if verdict->>'reason' <> 'capacity' then raise exception 'Counter oversold'; end if;
  verdict := public.ticket_door_sell('audit-staff-till',-1,'reduced','audit');
  if verdict->>'reason' <> 'capacity' then raise exception 'Counter tariff became negative'; end if;
  verdict := public.ticket_door_sell('audit-staff-till',-1,'full','audit');
  if verdict->>'ok' <> 'true' then raise exception 'Counter correction failed'; end if;
  verdict := public.ticket_door_sell_once('99999999-9999-4999-8999-999999999999','audit-staff-till',1,'full','audit');
  if verdict->>'ok' <> 'true' then raise exception 'Idempotent counter sale failed'; end if;
  verdict := public.ticket_door_sell_once('99999999-9999-4999-8999-999999999999','audit-staff-till',1,'full','audit');
  if verdict->>'ok' <> 'true' then raise exception 'Counter retry failed'; end if;
  if (select sum(delta) from public.screening_door_sales where screening='audit-staff-till') <> 2 then
    raise exception 'Counter retry duplicated the sale';
  end if;
  verdict := public.ticket_door_sell_once('99999999-9999-4999-8999-999999999999','audit-staff-till',-1,'full','audit');
  if verdict->>'reason' <> 'request_conflict' then raise exception 'Mismatched retry accepted'; end if;
  update public.passes set status='cancelled' where id=pass_id;
  verdict := public.ticket_check_in(badge_order->'codes'->>0,'audit-staff-a');
  if verdict->>'reason' <> 'not_valid' then raise exception 'Revoked badge ticket not refused'; end if;
  verdict := public.ticket_check_in(single_order->'codes'->>0,null);
  if verdict->>'reason' <> 'screening_required' then raise exception 'Missing screening accepted'; end if;
end;
$$;
rollback;
select 'PASS: live reservation, issuance, ticket/badge/day-pass admission and counter rules; transaction rolled back' as result,
  (select count(*) from public.screenings where code in ('audit-staff-a','audit-staff-b','audit-staff-till')) as remaining_test_screenings,
  (select count(*) from public.ticket_orders where email='staff-audit@example.invalid') as remaining_test_orders,
  (select count(*) from public.passes where email='staff-audit@example.invalid') as remaining_test_passes,
  (select count(*) from public.ticket_door_requests where id='99999999-9999-4999-8999-999999999999') as remaining_test_requests;
