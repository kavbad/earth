-- 0360 — blocks inside a live room (spec §21, §128 "Blocks override all discovery"; E2E 10).
--
-- `block_set` (0180) removes the social edges; this trigger applies the block to any room where
-- both Humans currently hold a seat, in the same transaction: the blocked Human loses their seat
-- (marked `removed`, so they can never come back to that room), unless they moderate the room and
-- the blocker does not — then the blocker leaves instead (Guests are never involved: they have no
-- social graph). Moderation is transferred and pending widenings re-evaluated as after any leave.
-- Discovery of future rooms is handled by earth.room_visible_to / earth.notify_live (0310).

create or replace function earth.blocks_apply_to_rooms_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_now timestamptz := earth.utc_now();
  v_pair record;
  v_leaver uuid;
  v_status public.participant_status;
begin
  for v_pair in
    select rp_blocker.room_id,
           rp_blocker.role in ('initiator', 'moderator') as blocker_moderates,
           rp_blocked.role in ('initiator', 'moderator') as blocked_moderates
      from public.room_participants rp_blocker
      join public.room_participants rp_blocked
        on rp_blocked.room_id = rp_blocker.room_id
       and rp_blocked.human_id = new.blocked_human_id
       and rp_blocked.status in ('invited', 'waiting', 'active')
      join public.rooms r on r.id = rp_blocker.room_id and r.status in ('starting', 'active')
     where rp_blocker.human_id = new.blocker_human_id
       and rp_blocker.status in ('invited', 'waiting', 'active')
  loop
    if v_pair.blocked_moderates and not v_pair.blocker_moderates then
      v_leaver := new.blocker_human_id;
      v_status := 'left';
    else
      v_leaver := new.blocked_human_id;
      v_status := 'removed';
    end if;
    update public.room_participants rp
       set status = v_status, left_at = v_now
     where rp.room_id = v_pair.room_id and rp.human_id = v_leaver and rp.status in ('invited', 'waiting', 'active');
    update public.human_presence hp set active_room_id = null
     where hp.human_id = v_leaver and hp.active_room_id = v_pair.room_id;
    perform earth.room_transfer_moderator(v_pair.room_id);
    perform earth.room_evaluate_pending_visibility(v_pair.room_id);
    perform earth.audit('room_block_applied', 'room', v_pair.room_id,
      jsonb_build_object('blockerHumanId', new.blocker_human_id, 'blockedHumanId', new.blocked_human_id, 'leaver', v_leaver, 'status', v_status));
  end loop;
  return new;
end
$$;

create trigger blocks_apply_to_rooms
  after insert on public.blocks
  for each row execute function earth.blocks_apply_to_rooms_trigger();

revoke execute on function earth.blocks_apply_to_rooms_trigger() from public, anon, authenticated;
