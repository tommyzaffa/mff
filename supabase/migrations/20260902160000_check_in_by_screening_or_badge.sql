-- The door scanner needs two things `ticket_check_in` could not do.
--
-- 1. It never looked at WHICH screening the ticket was for. A 22:30 ticket
--    scanned at the 18:00 door was admitted and, worse, burned — so its owner
--    could not get into the film they had actually paid for. The screening is
--    now checked before anything is written, and a mismatch comes back with the
--    right time so the staff can send the person away with an answer.
--
-- 2. An accredited guest books a free seat and is issued a ticket, but at the
--    door they hold out the badge, because that is the thing they printed. The
--    function now takes either, resolving a badge to the seat it booked for
--    this screening. A badge with no seat is refused: accreditation is not
--    admission, the room is finite, and the seat still has to be reserved.
--
-- The two code shapes cannot collide: a ticket is 'MFF-T-XXXXXXXX' and a badge
-- is 'MFF-XXXX-XXXX', so position 6 is a hyphen in one and a letter in the
-- other.
--
-- Note the local variables are NOT called `code`: that is a column name on both
-- `tickets` and `screenings`, and a PL/pgSQL variable of the same name makes
-- every `where code = ...` ambiguous.

set search_path = public, extensions;

-- The old one-argument version has to go, or a single-argument call becomes
-- ambiguous between it and the new default parameter.
drop function if exists public.ticket_check_in(text);

create or replace function public.ticket_check_in(
  p_code      text,
  p_screening text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  given  text := upper(btrim(coalesce(p_code, '')));
  want   text := nullif(btrim(coalesce(p_screening, '')), '');
  badge  text;
  t      public.tickets%rowtype;
  o      public.ticket_orders%rowtype;
  s      public.screenings%rowtype;
  seen   integer;
begin
  if given = '' then
    return jsonb_build_object('ok', false, 'reason', 'unknown_ticket');
  end if;

  if given not like 'MFF-T-%' then
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
    'badge', t.badge_code, 'checked_in', seen);
end;
$$;

revoke all on function public.ticket_check_in(text, text)
  from public, anon, authenticated;
grant execute on function public.ticket_check_in(text, text) to service_role;
