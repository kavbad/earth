-- 0730 — rate limit review (spec §83; DB_API §7 "Rate limits"; ARCHITECTURE §1 rule-home table).
--
-- Every rate limit is applied inside the RPC that performs the action, through
-- earth.rate_limit_for_caller(action, max, window_seconds) (0005): Humans and claiming credentials
-- get the full budget keyed by their auth user id; Guests (anonymous JWT) and Visitors (keyed by
-- earth.client_address()) get half of it, rounded up; the service is never limited. A refused
-- attempt raises `rate_limited` and its own increment rolls back with the transaction. Auth attempts
-- are GoTrue's own limits.
--
-- The table below is the reviewed inventory of limits. supabase/tests/src/safety/rate-limits.test.ts
-- parses it (one `-- | action | max | window_seconds | ... |` row per distinct call) and fails when it
-- drifts from the calls found in the function sources, and asserts that every mutating RPC calls
-- earth.rate_limit_for_caller. `max` is the Human budget; the Guest / Visitor budget is ceil(max / 2).
--
-- | action                     | max | window_seconds | RPC(s) — notes                                                     |
-- | claim_start                |  20 |           3600 | claim_start                                                        |
-- | claim_set_identity         |  30 |           3600 | claim_set_identity                                                 |
-- | claim_verification_begin   |  10 |           3600 | claim_verification_begin                                           |
-- | identity_review_create     |   5 |           3600 | identity_review_create                                             |
-- | claim_complete             |  10 |           3600 | claim_complete                                                     |
-- | identity_update            |  60 |           3600 | identity_update                                                    |
-- | friend_request             |  60 |           3600 | friend_request_send (spec §83 friend requests 60/h)                |
-- | friend_accept              | 120 |           3600 | friend_request_accept                                              |
-- | friend_decline             | 120 |           3600 | friend_request_decline                                             |
-- | friend_remove              | 120 |           3600 | friend_remove                                                      |
-- | follow                     |  60 |           3600 | follow_set (spec §83 follows 60/h)                                 |
-- | block                      |  60 |           3600 | block_set                                                          |
-- | presence_ping              | 600 |           3600 | presence_ping (every 30 s while foregrounded)                      |
-- | context_set                | 120 |           3600 | context_set                                                        |
-- | scope_set                  | 300 |           3600 | scope_set                                                          |
-- | push_token                 |  60 |           3600 | push_token_register, push_token_remove (shared window)             |
-- | group_create               |  20 |           3600 | group_create                                                       |
-- | group_update               |  60 |           3600 | group_update                                                       |
-- | group_invite_create        |  20 |           3600 | group_invite_create (spec §83 invite creation 20/h)                |
-- | group_invite_revoke        |  60 |           3600 | group_invite_revoke                                                |
-- | group_invite_preview       |  60 |             60 | group_invite_preview (visitors: 30/min)                            |
-- | group_invite_join          |  10 |            600 | group_invite_join (link joins 10/10min)                            |
-- | group_leave                |  60 |           3600 | group_leave                                                        |
-- | group_member_remove        |  60 |           3600 | group_member_remove                                                |
-- | group_member_set_role      |  60 |           3600 | group_member_set_role                                              |
-- | conversation_create        |  60 |           3600 | conversation_direct_get_or_create, conversation_group_create       |
-- | conversation_set_prefs     | 120 |           3600 | conversation_set_prefs                                             |
-- | message_send               |  60 |             60 | message_send (spec §83 messages 60/min)                            |
-- | message_edit               | 120 |             60 | message_edit                                                       |
-- | message_delete             | 120 |             60 | message_delete                                                     |
-- | message_reaction           | 120 |             60 | message_reaction_toggle                                            |
-- | conversation_mark_read     | 240 |             60 | conversation_mark_read                                             |
-- | room_start                 |  20 |           3600 | room_start (spec §83 Live creation 20/h)                           |
-- | room_join                  | 120 |           3600 | room_join                                                          |
-- | room_invite_join           |  10 |            600 | room_invite_join (link joins 10/10min; Guests 5)                   |
-- | room_set_media_state       | 240 |           3600 | room_set_media_state                                               |
-- | room_consent               | 240 |           3600 | room_consent                                                       |
-- | room_set_visibility        | 120 |           3600 | room_set_visibility                                                |
-- | room_set_join_policy       | 120 |           3600 | room_set_join_policy                                               |
-- | room_set_guests_disabled   | 120 |           3600 | room_set_guests_disabled                                           |
-- | room_admit                 | 240 |           3600 | room_admit                                                         |
-- | room_leave                 | 240 |           3600 | room_leave                                                         |
-- | room_end                   | 120 |           3600 | room_end                                                           |
-- | room_remove_participant    | 120 |           3600 | room_remove_participant                                            |
-- | room_invite_create         |  20 |           3600 | room_invite_create                                                 |
-- | room_invite_preview        |  60 |             60 | room_invite_preview (visitors: 30/min)                             |
-- | guest_session_create       |  10 |            600 | guest_session_create (Guests: 5/10min)                             |
-- | room_media_grant           | 120 |           3600 | room_media_grant (one token per join)                              |
-- | post_create                |  20 |           3600 | post_create (spec §83 posts 20/h)                                  |
-- | post_delete                |  60 |           3600 | post_delete                                                        |
-- | post_reaction_set          | 120 |             60 | post_reaction_set                                                  |
-- | post_hide                  | 120 |             60 | post_hide                                                          |
-- | area_resolve               | 240 |           3600 | area_resolve                                                       |
-- | areas_search               |  60 |             60 | areas_search (spec §83 search 60/min)                              |
-- | places_search              |  60 |             60 | places_search (spec §83 search 60/min)                             |
-- | place_create               |  20 |           3600 | place_create                                                       |
-- | location_share_create      |  30 |           3600 | location_share_create                                              |
-- | location_share_update      | 720 |           3600 | location_share_update (position every 5 s at most)                 |
-- | location_share_revoke      | 120 |           3600 | location_share_revoke                                              |
-- | context_resolve            | 240 |           3600 | context_resolve_and_set                                            |
-- | notification_mark_read     | 600 |           3600 | notification_mark_read                                             |
-- | notifications_mark_all_read| 120 |           3600 | notifications_mark_all_read                                        |
-- | analytics_track            | 600 |            600 | analytics_track (batches)                                          |
-- | rtc_diagnostic_record      | 120 |            600 | rtc_diagnostic_record                                              |
-- | search                     |  60 |             60 | search (spec §83 search 60/min; anonymous callers 30/min)          |
-- | report_create              |  20 |           3600 | report_create, Human branch (spec §83 reports 20/h)                |
-- | report_create              |  10 |           3600 | report_create, Guest branch: halved to 5/h (spec §83 "stricter")   |
-- | report_resolve             | 600 |           3600 | report_resolve (service: never limited; the call keeps the rule)   |
--
-- Windows are pruned by rooms_sweep() through earth.rate_limit_prune() (0005).

-- Test / operations helper: clears the windows of one subject (an auth user id, a client address or
-- the shared 'anon' key), optionally for one action only. Service only (`forbidden` otherwise); never
-- reachable by clients, like every rate-limit function. Returns the number of windows removed.
create or replace function earth.rate_limit_reset(subject text, action text default null)
returns integer
language plpgsql
volatile
security definer
set search_path = public, earth, private, pg_temp
as $$
declare
  v_deleted integer;
begin
  if not earth.is_service_role() then
    perform earth.raise('forbidden');
  end if;
  if subject is null or subject = '' then
    perform earth.raise('invalid_input', 'earth.rate_limit_reset: subject is required');
  end if;
  if action is not null and (action = '' or position(':' in action) > 0) then
    perform earth.raise('invalid_input', 'earth.rate_limit_reset: action must not contain ":"');
  end if;
  delete from private.rate_limits rl
   where substr(rl.key, position(':' in rl.key) + 1) = subject
     and (action is null or split_part(rl.key, ':', 1) = action);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$$;

revoke execute on function earth.rate_limit_reset(text, text) from public, anon, authenticated;
