-- Stopping a talk hands the room back to the next one. The audience screen used
-- to keep the last caption of a finished talk for days, so `stop` now writes the
-- waiting state, and the text is cleared here rather than trusted to the client.
create or replace function public.live_caption_update(p_room text, p_publisher uuid, p_sequence bigint,
  p_state text, p_original text, p_translated text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.live_caption_rooms; p public.live_caption_publishers;
begin
  if p_publisher is null or p_sequence is null or p_sequence < 1 or p_sequence > 10000000
    or p_state is null or p_state not in ('connecting','live','reconnecting','ended','idle')
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
  -- Handing the room back always goes through, even after the lease expired: a
  -- stop during a network drop would otherwise leave the last caption on screen
  -- for the rest of the festival. Only this publisher can do it, and only once.
  if p_state<>'idle' and (p.lease_until<=now() or p.ends_at<=now() or r.state in ('ended','idle')) then
    return jsonb_build_object('ok',false,'error','lease_lost');
  end if;
  update live_caption_publishers set sequence=p_sequence,
    lease_until=case when p_state in ('ended','idle') then now() else least(ends_at,now()+interval '45 seconds') end
    where room=p_room;
  update live_caption_rooms set state=p_state,
    original=case when p_state='idle' then '' else p_original end,
    translated=case when p_state='idle' then '' else p_translated end,
    revision=revision+1,updated_at=now() where id=p_room;
  return jsonb_build_object('ok',true,'ends_at',p.ends_at);
end $$;
