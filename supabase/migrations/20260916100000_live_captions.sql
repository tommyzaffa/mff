-- Public display data is separate from private publisher ownership.
create table public.live_caption_rooms (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  title text not null default 'Merge Film Festival' check (length(title) <= 120),
  state text not null default 'idle' check (state in ('idle','connecting','live','reconnecting','ended')),
  original text not null default '' check (length(original) <= 1500),
  translated text not null default '' check (length(translated) <= 1500),
  revision bigint not null default 0,
  updated_at timestamptz not null default now()
);
create table public.live_caption_publishers (
  room text primary key references public.live_caption_rooms(id),
  publisher uuid not null,
  lease_until timestamptz not null,
  ends_at timestamptz not null,
  sequence bigint not null default 0
);
alter table public.live_caption_rooms enable row level security;
alter table public.live_caption_publishers enable row level security;
revoke all on public.live_caption_rooms, public.live_caption_publishers from public, anon, authenticated;
grant select on public.live_caption_rooms to anon, authenticated;
grant all on public.live_caption_rooms, public.live_caption_publishers to service_role;
create policy live_captions_read on public.live_caption_rooms for select to anon, authenticated using (true);
insert into public.live_caption_rooms(id) values ('main');

-- Serialized claim and mutations: an old tab or a delayed HTTP retry can never
-- overwrite a new publisher, resurrect an ended session, or reorder captions.
create function public.live_caption_claim(p_room text, p_publisher uuid, p_title text, p_minutes integer)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.live_caption_rooms; p public.live_caption_publishers;
begin
  if p_publisher is null or p_minutes is null or p_minutes not between 5 and 240
    or p_title is null or length(p_title) > 120 then
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
    revision=revision+1,updated_at=now() where id=p_room returning * into r;
  return jsonb_build_object('ok',true,'ends_at',now()+make_interval(mins=>p_minutes),'snapshot',to_jsonb(r));
end $$;

create function public.live_caption_update(p_room text, p_publisher uuid, p_sequence bigint,
  p_state text, p_original text, p_translated text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.live_caption_rooms; p public.live_caption_publishers;
begin
  if p_publisher is null or p_sequence is null or p_sequence < 1 or p_sequence > 10000000
    or p_state is null or p_state not in ('connecting','live','reconnecting','ended')
    or p_original is null or p_translated is null
    or length(p_original)>1500 or length(p_translated)>1500 then
    return jsonb_build_object('ok',false,'error','bad_request');
  end if;
  select * into r from live_caption_rooms where id=p_room for update;
  select * into p from live_caption_publishers where room=p_room;
  if not found or p.publisher<>p_publisher then
    return jsonb_build_object('ok',false,'error','lease_lost');
  end if;
  -- Idempotent acknowledgement, without extending a stopped or expired lease.
  if p_sequence<=p.sequence then return jsonb_build_object('ok',true,'ends_at',p.ends_at); end if;
  if p.lease_until<=now() or p.ends_at<=now() or r.state='ended' then
    return jsonb_build_object('ok',false,'error','lease_lost');
  end if;
  update live_caption_publishers set sequence=p_sequence,
    lease_until=case when p_state='ended' then now() else least(ends_at,now()+interval '45 seconds') end
    where room=p_room;
  update live_caption_rooms set state=p_state,original=p_original,translated=p_translated,
    revision=revision+1,updated_at=now() where id=p_room;
  return jsonb_build_object('ok',true,'ends_at',p.ends_at);
end $$;

revoke all on function public.live_caption_claim(text,uuid,text,integer) from public,anon,authenticated;
revoke all on function public.live_caption_update(text,uuid,bigint,text,text,text) from public,anon,authenticated;
grant execute on function public.live_caption_claim(text,uuid,text,integer) to service_role;
grant execute on function public.live_caption_update(text,uuid,bigint,text,text,text) to service_role;
-- The publication exists on Supabase; isolated tests do not require replication.
do $$ begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    alter publication supabase_realtime add table public.live_caption_rooms;
  end if;
end $$;
