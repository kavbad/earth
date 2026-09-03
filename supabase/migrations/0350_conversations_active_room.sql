-- 0350 — active room pointers on chats and groups (DB_API §2 `activeRoom`; SCREEN 08/10/12).
--
-- `conversations_list`, `conversation_get` and `group_get` (0185) build their `activeRoom`
-- (`ActiveRoomRefDto {roomId, participantCount}`) through `earth.active_room_ref_json`, which 0160
-- defined dynamically for a `rooms` table that did not exist yet. 0310 replaced it with the static
-- version over `public.rooms`; this migration pins the contract: the helper is the single source
-- for the pointer (live rooms only, trigger-maintained participant count) and the RPC signatures
-- of 0185 are unchanged. Clearing happens in `earth.room_end_internal`; setting in `room_start`.

create or replace function earth.active_room_ref_json(room_id uuid)
returns jsonb
language sql
stable
set search_path = public, earth, private, pg_temp
as $$
  select jsonb_build_object('roomId', r.id, 'participantCount', greatest(r.active_participant_count, 0))
    from public.rooms r
   where r.id = active_room_ref_json.room_id
     and r.status in ('starting', 'active')
$$;

-- A group's or conversation's pointer must always name a live room; the sweep/end path clears
-- stale pointers, and this guard heals any pointer left behind by an ended room.
create or replace function earth.clear_stale_active_room_pointers()
returns integer
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_groups integer;
  v_conversations integer;
begin
  update public.groups g set active_room_id = null
   where g.active_room_id is not null
     and not exists (select 1 from public.rooms r where r.id = g.active_room_id and r.status in ('starting', 'active'));
  get diagnostics v_groups = row_count;
  update public.conversations c set active_room_id = null
   where c.active_room_id is not null
     and not exists (select 1 from public.rooms r where r.id = c.active_room_id and r.status in ('starting', 'active'));
  get diagnostics v_conversations = row_count;
  return v_groups + v_conversations;
end
$$;

revoke execute on function earth.clear_stale_active_room_pointers() from public, anon, authenticated;
