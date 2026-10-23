-- A second festival (OMNI x AI Youth, Ningbo) runs on the same system, so a
-- room can now be translated into Chinese. Nothing else about a room changes.
do $$
declare constraint_name text;
begin
  select conname into constraint_name from pg_constraint
    where conrelid = 'public.live_caption_rooms'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%language%';
  if constraint_name is not null then
    execute format('alter table public.live_caption_rooms drop constraint %I', constraint_name);
  end if;
end $$;
alter table public.live_caption_rooms
  add constraint live_caption_rooms_language_check check (language in ('en','it','zh'));

create or replace function public.live_caption_claim(p_room text, p_publisher uuid, p_title text, p_minutes integer,
  p_language text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.live_caption_rooms; p public.live_caption_publishers;
begin
  if p_publisher is null or p_minutes is null or p_minutes not between 5 and 240
    or p_title is null or length(p_title) > 120 or p_language is null or p_language not in ('en','it','zh') then
    return jsonb_build_object('ok',false,'error','bad_request');
  end if;
  select * into r from live_caption_rooms where id=p_room for update;
  if not found then return jsonb_build_object('ok',false,'error','room_not_found'); end if;
  select * into p from live_caption_publishers where room=p_room;
  if found and p.lease_until > now() and p.ends_at > now() then
    if p.publisher <> p_publisher then return jsonb_build_object('ok',false,'error','room_busy'); end if;
    -- Repeating a lost start request is idempotent; never clears captions.
    return jsonb_build_object('ok',true,'ends_at',p.ends_at,'snapshot',to_jsonb(r));
  end if;
  insert into live_caption_publishers(room,publisher,lease_until,ends_at)
    values(p_room,p_publisher,now()+interval '45 seconds',now()+make_interval(mins=>p_minutes))
    on conflict(room) do update set publisher=excluded.publisher, lease_until=excluded.lease_until,
      ends_at=excluded.ends_at, sequence=0;
  update live_caption_rooms set title=p_title,state='connecting',original='',translated='',
    language=p_language,revision=revision+1,updated_at=now() where id=p_room returning * into r;
  return jsonb_build_object('ok',true,'ends_at',now()+make_interval(mins=>p_minutes),'snapshot',to_jsonb(r));
end $$;
