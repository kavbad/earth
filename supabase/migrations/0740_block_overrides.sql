-- 0740 — block overrides review (spec §21, §56, §128 "Blocks override all discovery").
--
-- Nothing new is created here: every surface spec §21 names already consults the block state
-- through the primitives of 0130 (`earth.has_blocked`, `earth.is_blocked_either`). This migration
-- records where each override lives and guards the primitives' signatures so a later range cannot
-- silently drop one. supabase/tests/src/safety/block-overrides.test.ts proves each line end to end.
--
--   Surface (spec §21)   Home                                                           Behavior
--   messaging            earth.assert_conversation_access (0270), earth.can_view_conversation
--                        (0260), conversation_direct_get_or_create (0185)                `blocked` on send / open; direct messages unreadable either way
--   feed eligibility     earth.can_view_post (0410) → feed_candidates / public_feed / post_get (0430)
--                                                                                       no post of a blocked pair in any scope, no reaction / reply
--   Live discovery       earth.room_blocked_for → earth.room_visible_to (0310) → room_get, room_join,
--                        live_candidates (0330), rooms / room_participants RLS (0320)  the room does not exist for the other side
--   search               earth.identity_visible_to (0160) → public_identities RLS (0170), profile_get (0180)
--                                                                                       identities hidden both ways (the 09xx search RPC builds on the same rule)
--   notifications        earth.notify (0190), earth.notify_live (0310)                 no row is ever created across a block
--   location visibility  earth.revoke_location_shares_between (0180, on block), location_shares_visible
--                        and earth.location_share_assert_audience (0530)               existing friend shares revoked; nothing visible; no new share
--   friend suggestions   block_set (0180) deletes friend / pending / follow edges       no edge survives (V1 has no suggestion surface)
--   rooms in progress    earth.blocks_apply_to_rooms_trigger (0360)                    a blocked pair never shares a live room
--
-- Fail loudly at migration time if any primitive an override depends on is missing.
do $$
declare
  v_missing text[] := '{}';
  v_signature text;
begin
  foreach v_signature in array array[
    'earth.has_blocked(uuid, uuid)',
    'earth.is_blocked_either(uuid, uuid)',
    'earth.identity_visible_to(uuid, uuid)',
    'earth.can_view_post(uuid, uuid)',
    'earth.can_view_conversation(uuid, uuid)',
    'earth.assert_conversation_access(uuid, uuid)',
    'earth.room_blocked_for(uuid, uuid)',
    'earth.room_visible_to(uuid, uuid, uuid)',
    'earth.notify(uuid, text, uuid, text, uuid, jsonb, public.notification_priority)',
    'earth.notify_live(uuid, uuid)',
    'earth.revoke_location_shares_between(uuid, uuid)',
    'earth.location_share_reaches(public.location_shares, uuid)',
    'earth.blocks_apply_to_rooms_trigger()'
  ]
  loop
    if to_regprocedure(v_signature) is null then
      v_missing := v_missing || v_signature;
    end if;
  end loop;
  if array_length(v_missing, 1) > 0 then
    raise exception 'block override primitives missing: %', array_to_string(v_missing, ', ');
  end if;
  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'public.blocks'::regclass and t.tgname = 'blocks_apply_to_rooms' and not t.tgisinternal
  ) then
    raise exception 'trigger blocks_apply_to_rooms on public.blocks is missing';
  end if;
end
$$;
