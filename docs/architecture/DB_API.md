# Earth V1 — Database API Contract

Binding contract for every migration, RPC, and the typed client. Companion to
`ARCHITECTURE.md` (§4–§12). Spec sections are cited as `spec §N`.

Conventions recap: all RPCs are `security definer`, `set search_path = public, earth, private, pg_temp`,
return `jsonb` in **camelCase** matching `packages/domain/src/dto`, raise errors via
`earth.raise('<code>')` with codes from `packages/domain/src/errors.ts`, and rate-limit with
`earth.rate_limit_for_caller(action, max, window_seconds)`. `earth.current_role_kind()` decides who may call.

Caller kinds: `visitor` (anon), `guest` (anonymous auth user), `claiming` (auth user with pending Human),
`human` (active Human), `service` (service role).

### Migration ordering note

Some primitives are referenced by RPCs in earlier numbering ranges than their "home" section below. They are
created early and only their RPCs live in the later range:

- `0006_flags_settings.sql` — `feature_flags`, `app_settings`, `earth.flag(key)`, `earth.setting(key)` (seeded defaults). §8 keeps analytics/metrics only.
- `0050_areas_places.sql` — `areas` and `places` tables (PostGIS) with `earth.area_contains(parent, child)`; §5 keeps area/location/map RPCs and seeds.
- `0110_media_objects.sql` — before `public_identities`.
- `0190_notifications.sql` — `notifications` table, `notification_cooldowns`, `earth.notify(...)`; §6 keeps the notification RPCs, push, presence.
- `0195_audit.sql` — `private.audit_log` and `earth.audit(...)`; §7 keeps reports.

## 1. Identity (migrations 01xx)

### Tables

`humans` — spec §16, plus:
- `auth_user_id uuid unique` (the Supabase auth user that owns this Human; nullable after deletion)
- `claim_intent text` (`start_group` | `join_group`), `claim_group_label text`, `claim_invite_token_hash text` — the Claiming state (spec §45–46) lives on the pending Human row.

`public_identities` — spec §17 exactly, with `avatar_media_id` referencing `media_objects.id` (below) and `handle` stored lowercase with a `citext`-free unique index on `lower(handle)`.

`media_objects` — `id, owner_human_id, bucket text, storage_key text, content_type, width, height, duration_ms, byte_size, created_at`. Referenced by avatars, post media, messages. Public URL for `avatars` bucket; signed URLs for others (server tier).

`auth_identities` — spec §18. One row `provider='supabase'` per Human (`provider_subject = auth_user_id::text`), plus method rows.

`human_passes` — spec §19; `metadata_private` moved to `private.human_pass_metadata(human_pass_id pk, metadata jsonb)` so `public.human_passes` never carries it.

`identity_reviews` — `id, human_id, kind ('duplicate' | 'inconclusive' | 'help' | 'safety' | 'recovery'), status ('open' | 'approved' | 'rejected'), details jsonb, created_at, resolved_at`. Created by "This isn't me", "I need help", "Safety issue", "Get help verifying", and duplicate detection (spec §48, §79).

`relationships` — spec §20. Friendship is stored as **two rows** (`friend` in both directions) written in one transaction; `friend_pending` is a single directional row from requester to target; `follow` directional; `familiar_private` directional and hidden from the target.

`blocks` — spec §21. `earth.is_blocked_either(a, b)` helper.

`human_presence` — `human_id pk, last_active_at, active_conversation_id, active_room_id, platform`.

`human_context` — `human_id pk, current_area_id, current_city_id, home_city_id, last_scope_home, last_scope_live, last_scope_earth, updated_at`. Stores scope selection (spec §51) and area context only, never coordinates.

`push_tokens` — `human_id, token text, platform ('ios' | 'android' | 'web'), updated_at`, pk `(human_id, token)`.

### Helper functions

- `earth.current_human_id()`, `earth.current_human()`, `earth.current_role_kind()` (ARCHITECTURE §4).
- `earth.assert_human()` → returns active human id or raises `not_a_human` / `human_not_active`.
- `earth.are_friends(a, b)`, `earth.is_following(a, b)`, `earth.shared_group_count(a, b)`, `earth.relation_to(viewer, other)` → `'self' | 'friend' | 'shared_group' | 'familiar' | 'other'`.
- `earth.identity_json(human_id)` → `{humanId, displayName, handle, avatarUrl}` (avatar URL built from `avatars` bucket public path with `earth.public_media_url(media_id)`; base URL from `feature_flags`-adjacent table `app_settings(key, value)` with key `public_storage_base_url`).
- `earth.flag(key)` boolean.

### RLS summary

- `humans`: select own row only (any auth kind); no client writes.
- `public_identities`: select where the Human is `active` and (`profile_visibility <> 'hidden'` or viewer is self or friend) and not blocked either way; update own row (display_name, bio, avatar, visibility fields) only when Human is active or pending (claim step). Insert only via RPC.
- `auth_identities`, `human_passes`, `identity_reviews`: select own rows only; writes via RPC/service.
- `relationships`: select where viewer is source, or viewer is target and type ≠ `familiar_private`; writes via RPC.
- `blocks`: select own (as blocker); writes via RPC.
- `human_presence`, `human_context`, `push_tokens`: own row select/upsert (Human only).
- `media_objects`: select own or referenced by content the viewer can see (kept simple: own + public avatar objects); insert own.

### RPCs

| RPC | Caller | Behavior |
| --- | --- | --- |
| `claim_start(intent text, group_label text, invite_token text)` | auth user without Human | Creates `humans(status=pending)` + `auth_identities(supabase)`; if a pending Human already exists for this auth user, updates intent fields. If `earth.flag('GROUP_ANCHORED_CLAIM_REQUIRED')` and intent is null → `invalid_input`. For `join_group`, validates the invite (`invite_invalid`/`invite_expired`/`invite_exhausted`) and stores its hash. Returns `ClaimStateDto`. |
| `claim_get()` | claiming/human | Returns `ClaimStateDto` (for humans: status `claimed`). |
| `claim_set_identity(display_name, handle, avatar_media_id)` | claiming | Validates handle (`handle_invalid`, `handle_taken`), upserts `public_identities`. Returns `ClaimStateDto`. |
| `claim_verification_begin(provider text)` | claiming | Creates/updates `human_passes(status=verifying)`, sets `humans.human_pass_status=verifying`. Returns `{humanPassId}`. (Server tier then calls the provider and records the result.) |
| `human_pass_record_result(human_id, status human_pass_status, risk_level text, provider text, provider_reference text, metadata jsonb, duplicate_of_human_id uuid)` | service | Updates `human_passes`, writes `private.human_pass_metadata`, sets `humans.human_pass_status`; on `review_required` with `duplicate_of_human_id` inserts `identity_reviews(kind='duplicate')`. Never activates the Human. |
| `identity_review_create(kind text, details jsonb)` | claiming/human | Inserts a review row (help / this isn't me / safety / recovery). Rate limited. |
| `claim_complete()` | claiming | Requires: `humans.status=pending`, identity set, `human_pass_status='verified'` or an `identity_reviews` row with `status='approved'`, no open `duplicate` review. In one transaction: `humans.status=active, claimed_at=now()`; then by intent: `start_group` → `earth.group_create_internal(human_id, label)` (group + owner membership + conversation + conversation member); `join_group` → `earth.group_invite_join_internal(human_id, token_hash)`. Returns `ClaimCompleteDto`. Errors: `claim_not_pending`, `claim_identity_missing`, `verification_required`, `verification_pending`, `duplicate_human`. |
| `profile_get(handle text)` | any | Returns `ProfileDto` respecting visibility and blocks; visitors get `public` profiles only; increments nothing. |
| `identity_update(display_name, bio, avatar_media_id, profile_visibility, public_city_visibility, home_city_area_id)` | human | Updates own identity. |
| `handle_available(handle)` | any auth | boolean. |
| `friend_request_send(target_human_id)` | human | Blocks → `blocked`; already friends → no-op; reverse pending exists → accepts (creates both `friend` rows, deletes pending, notification `friend_accepted` to the original requester). Otherwise inserts `friend_pending` and notification `friend_request`. Rate limited. |
| `friend_request_accept(source_human_id)` | human | Accepts a pending request from source. |
| `friend_request_decline(source_human_id)` | human | Deletes pending. |
| `friend_remove(other_human_id)` | human | Deletes both friend rows. |
| `follow_set(target_human_id, following boolean)` | human | Creates/deletes `follow`; notification `follow` on create; blocks → `blocked`. |
| `block_set(target_human_id, blocked boolean)` | human | Creates/deletes block; on create also deletes friend/pending/follow edges both ways and any active `location_shares` between them. |
| `presence_ping(conversation_id uuid, room_id uuid, platform text)` | human | Upserts `human_presence`. |
| `context_set(current_area_id, current_city_id, home_city_id)` and `scope_set(surface text, scope audience)` | human | Upsert `human_context`. |
| `push_token_register(token, platform)` / `push_token_remove(token)` | human | Manage tokens. |
| `me_get()` | any auth | `{roleKind, humanId, identity, humanStatus, humanPassStatus, context: HumanContextDto, flags}`. |

## 2. Groups and conversations (migrations 02xx)

### Tables

`groups` — spec §22 plus `active_room_id uuid` (FK added in 03xx) and `member_count int` maintained by trigger.
`group_members` — spec §23, pk `(group_id, human_id)`, plus `left_at`, `removed_by_human_id`.
`group_invites` — spec §24 (`status` values exactly as `GROUP_INVITE_STATUSES` in `packages/domain/src/enums.ts`; `expired`/`exhausted` may be derived at read time or materialized by `rooms_sweep`), `token_hash` unique.
`conversations` — spec §25 plus `active_room_id uuid`, `direct_key text unique` (sorted pair of human ids for direct conversations, `null` for group).
`conversation_members` — spec §26 (`mute_state`: `none` | `muted`, `notification_level`: `all` | `mentions` | `none`), `unread_count int` maintained by trigger, `last_read_at`.
`messages` — spec §27 plus `client_id uuid`, unique `(conversation_id, sender_human_id, client_id)`; `deleted_at` tombstone keeps `id`, `conversation_id`, `sender_human_id`, `reply_to_message_id`, `created_at`, sets `text=null`, `payload='{}'`.
`message_reactions` — spec §28, plus a denormalized `conversation_id` (set by trigger from the message) so realtime subscriptions can filter by conversation; unique `(message_id, human_id, reaction)`.
`message_reads` not needed; `conversation_members.last_read_message_id` per spec §55.

### RLS summary

- `groups`: select if active member (any status ≠ left/removed) or the group appears in an invite preview via RPC (preview does not use table select). No client writes.
- `group_members`: select rows of groups the viewer is an active member of. No client writes.
- `group_invites`: select rows created by viewer or where viewer is owner/moderator; never expose `token_hash` to clients (column-level: a view `group_invites_view` without hash is what the client reads; grants only on the view).
- `conversations`, `conversation_members`: select if member. `conversation_members` update own row for mute/notification/last_read.
- `messages`: select if conversation member **and** not (direct conversation and blocked either way); insert only via RPC; update/delete own via RPC.
- `message_reactions`: select if message visible; write via RPC.

### RPCs

| RPC | Caller | Behavior |
| --- | --- | --- |
| `group_create(name text)` | human | Group + owner membership + conversation + member; notification none. Returns `GroupDto`. Rate limited. |
| `group_get(group_id)` | member | `GroupDto` with members (`GroupMemberDto[]`, relation flags), invites summary for owner/moderator. |
| `group_update(group_id, name, avatar_media_id)` | owner/moderator | |
| `group_invite_create(group_id, expires_in_seconds int, max_uses int)` | member (owners/moderators may set limits; members get default 30-day, unlimited) | Returns `GroupInviteCreateDto` with plaintext token once. Rate limited (spec §83). |
| `group_invite_revoke(invite_id)` | owner/moderator | |
| `group_invite_preview(token text)` | any | `GroupInvitePreviewDto`: group name, `memberCount`, up to 5 `sampleMembers` whose `profile_visibility='public'` (or friends of viewer when viewer is a Human), `alreadyMember`, `expired`. Never messages. Rate limited (visitors stricter). |
| `group_invite_join(token text)` | human | Validates usability, inserts membership + conversation member, increments `use_count`, notification `group_invitation` to the joiner is **not** sent (they acted); a system message "<name> joined" is inserted; analytics-relevant: returns `{groupId, conversationId, isSecondGroup: boolean}` (true if the Human already had another active membership). |
| `group_leave(group_id)` | member | Owner leaving transfers ownership to earliest moderator else earliest member; last member leaving archives the group (`status='archived'`). |
| `group_member_remove(group_id, human_id)` | owner/moderator | Sets `removed`, removes conversation membership. |
| `group_member_set_role(group_id, human_id, role)` | owner | Promote/demote moderator. |
| `conversation_direct_get_or_create(other_human_id)` | human | Blocks → `blocked`. Returns `ConversationSummaryDto`. |
| `conversation_group_create(human_ids uuid[])` | human | 2+ others → creates a `groups(kind='temporary', name=null)` + conversation (spec §9 New chat: no name forced). |
| `conversations_list(cursor timestamptz, limit int)` | human | `ConversationSummaryDto[]` ordered by `last_message_at desc`, includes `activeRoom` summary and unread counts. |
| `conversation_get(conversation_id)` | member | Summary + members. |
| `messages_list(conversation_id, before_id uuid, limit int)` | member | Keyset by `(created_at, id)` descending. Returns `MessagesPageDto`. |
| `messages_since(conversation_id, after_id uuid)` | member | Polling fallback; ascending, max 200. |
| `message_send(conversation_id, client_id uuid, type message_type, text, payload jsonb, reply_to_message_id)` | member | Idempotent on `(conversation_id, sender, client_id)` (returns the existing `MessageDto`). Direct conversation with a block either way → `blocked`. Updates `conversations.last_message_at`, unread counts, `groups.last_activity_at`; creates `direct_message`/`group_message` notifications for members with `notification_level='all'` and `mute_state='none'` (payload has preview truncated to 120 chars). Rate limited 60/min. |
| `message_edit(message_id, text)` / `message_delete(message_id)` | sender (moderators may delete in groups) | |
| `message_reaction_toggle(message_id, reaction text)` | member | |
| `conversation_mark_read(conversation_id, message_id)` | member | Sets `last_read_message_id`, zeroes unread. |
| `conversation_set_prefs(conversation_id, mute_state, notification_level)` | member | |
| `conversation_read_receipts(conversation_id)` | member | `[{humanId, lastReadMessageId}]` for "Seen by". |

Realtime: `messages`, `message_reactions`, `conversation_members`, `conversations` in publication.

## 3. Rooms, Guests, Live (migrations 03xx)

### Tables

`rooms` — spec §32 plus `pending_visibility room_visibility`, `guests_disabled boolean default false`, `title text` (optional activity label like "Cooking dinner"), `active_human_count int`, `active_participant_count int` (trigger-maintained), `last_activity_at`, `ended_reason text`.
`room_participants` — spec §33 plus `livekit_identity text` (`h:<human_id>` or `g:<guest_session_id>`), `display_name_snapshot text` (for guests), `consent_recorded_at`. Unique active participant per (room, human) / (room, guest).
`guest_sessions` — spec §34 plus `auth_user_id uuid` (anonymous auth user), `room_invite_id`.
`room_invites` — spec §35 (+ `status`).
`notification_cooldowns` — `recipient_human_id, room_id, last_sent_at, sends_in_window int default 1, notified_participant_ids uuid[]`, pk `(recipient_human_id, room_id)`. `sends_in_window` mirrors the `sendsInWindow` input of `shouldNotifyLive` in `packages/domain/src/notifications/dedupe.ts`; the SQL rule must produce the same decisions as that function (share the same scenarios in tests).
`live_room_state` (view or materialized): active rooms with visibility ≥ friends, participant summaries, area ids — used by discovery.

### Helper functions

- `earth.room_is_moderator(room_id, human_id)`, `earth.room_active_participant(room_id)` for caller (Human or Guest).
- `earth.room_visible_to(room_id, viewer_human_id)` — applies visibility, blocks (blocked with any consenting camera/audio participant → not visible), group membership, friend graph union (spec §58), area for neighborhood/city, world.
- `earth.room_evaluate_pending_visibility(room_id)` — applies `pending_visibility` when all active audio/camera Humans have consent ≥ pending; then creates Live notifications through `earth.notify_live(room_id)`.
- `earth.notify_live(room_id)` — computes eligible recipients (union of friend graphs of consenting active Human participants, group members for group rooms, filtered by blocks and cooldowns) and inserts notifications with dedupe per spec §87.
- `earth.room_end_internal(room_id, reason)` — sets status ended, `ended_at`, clears `groups.active_room_id` / `conversations.active_room_id`, marks participants `left`, expires guest sessions after grace.

### RLS summary

- `rooms`: select if caller is/was a participant, or group member for group rooms, or `earth.room_visible_to(...)`; guests: only their room. No client writes.
- `room_participants`: select for rooms the caller can see. No client writes.
- `guest_sessions`: guest sees own row (no hash); moderators see rows of their room (no hash). No client writes.
- `room_invites`: creator/moderators (via a view without hash).
- `notification_cooldowns`: none.

### RPCs

| RPC | Caller | Behavior |
| --- | --- | --- |
| `room_start(context_type room_context_type, context_id uuid, title text)` | human | Group: must be member; returns existing active room (join as `watching` participant if not already) else creates with defaults (ARCHITECTURE §10), initiator participant with `media_state='camera'`, `audience_consent_level = visibility`, sets `groups.active_room_id`, inserts a system message in the group conversation, notifications `group_live` per preferences (spec §57 step 8). Direct: context is a conversation id; both members invited. Standalone: friends/friends. Rate limited (spec §83 Live creation). Returns `RoomStartDto`. |
| `room_get(room_id)` | visible | `RoomDto` with `myParticipant`, participants with `relationToViewer`, `contextTitle`. |
| `room_join(room_id, media_state, consent_level room_visibility)` | human or guest | Checks `join_policy` against caller relation (invited participant row, group member, friend of any consenting camera/audio participant, friends_of_friends, request → creates `waiting`, anyone/anyone_with_link (link requires an unexpired invite token passed via `room_invite_join`)); guests only via `guest_session_create` path. If `media_state <> 'watching'` and `consent_level < visibility` → `consent_required`. Upserts participant `active`, sets role `participant`/`viewer`. Sends "join" Live notifications via `earth.notify_live` when a Human joins on camera (dedupe decides). Returns `RoomDto`. |
| `room_invite_join(token, media_state, consent_level)` | human | Validates room invite then `room_join` with link privilege. |
| `room_set_media_state(room_id, media_state, consent_level)` | participant | Camera/audio requires consent ≥ visibility; downgrading to `watching` re-evaluates pending visibility. |
| `room_consent(room_id, level)` | participant | Records consent (max of current and level), re-evaluates pending visibility. Returns `RoomVisibilityChangeDto`. |
| `room_set_visibility(room_id, visibility, join_policy)` | moderator | Narrowing applies immediately (and clears pending). Widening: flags `FRIENDS_LIVE_EXPANSION_ENABLED` (≥ friends) / `WORLD_LIVE_EXPANSION_ENABLED` (≥ neighborhood) / `PUBLIC_LIVE_ENABLED`; evaluates consent (ARCHITECTURE §10); when applied sets `area_precision`/`area_id` from the moderator's `human_context` for neighborhood/city/world (city precision by default). Returns `RoomVisibilityChangeDto`. |
| `room_set_join_policy(room_id, join_policy)` | moderator | Must be in `allowedJoinPoliciesFor(visibility)`. |
| `room_set_guests_disabled(room_id, disabled)` | moderator | Disabling removes active guests. |
| `room_admit(room_id, participant_id)` | moderator | `waiting` → `active`. |
| `room_leave(room_id)` | participant/guest | Marks `left`; moderator transfer per spec §61 (returns `{transferredTo}` so the client can toast "You're keeping the room open."); if no active Humans remain the room is left for `rooms_sweep` (grace). |
| `room_end(room_id, reason)` | moderator | Ends immediately. |
| `room_remove_participant(room_id, participant_id, block_from_room boolean)` | moderator | Sets `removed`; guests get `guest_sessions.removed_at` and (if block) `device_fingerprint_hash` added to `room_blocked_fingerprints(room_id, hash)`. |
| `room_invite_create(room_id, expires_in_seconds, join_policy_override)` | participant (Human) | Guest rooms require `GUEST_ROOMS_ENABLED`. Plaintext token once. Rate limited. |
| `room_invite_preview(token)` | any | `RoomInvitePreviewDto` (participants' display names/avatars, context title, join policy, guestsAllowed = flag and not disabled and policy allows link, `ended`). |
| `guest_session_create(token, display_name, device_fingerprint_hash)` | guest (anonymous auth user) | Requires `GUEST_ROOMS_ENABLED`, room active, invite usable, `guests_disabled=false`, fingerprint not blocked; creates `guest_sessions` (secret returned once) + participant `active` with `media_state` from arg (default `audio`), `audience_consent_level = visibility`. Rate limited strictly (spec §83). Returns `GuestSessionDto`. |
| `guest_session_get()` | guest | Own sessions (for "You've joined N rooms" copy: counts of distinct rooms and distinct Humans met, from `room_participants`). |
| `room_media_grant(room_id)` | active participant (Human or Guest) | `MediaGrantDto`: `canPublish = media_state <> 'watching'`, `canSubscribe = true`, `canPublishData = true`, `ttlSeconds = 7200`. Ended room → `room_ended`. |
| `room_participant_sync(room_id, livekit_identity, event text, at timestamptz)` | service | Reconciles from LiveKit webhooks (`participant_joined` → ensure active; `participant_left` → mark left if still active; `room_finished` → end). Out-of-order events (older than `left_at`) are ignored and reported. |
| `rooms_sweep()` | service | Ends rooms with `active_human_count = 0` for longer than `ROOM_GRACE_SECONDS` (from `app_settings`), ends rooms with no active participants at all, expires guest sessions (`expires_at < now()`), revokes expired location shares, prunes `private.rate_limits`. Returns counts. |
| `live_candidates(scope audience, area_id uuid, limit int)` | any (visitors: world only when `PUBLIC_LIVE_ENABLED`) | Active rooms visible to caller in that scope with participants (names, avatars, relation to viewer), context title, area name, started_at. Ordering is done in the server tier (naming + rank per spec §13 Live Home). |

## 4. Posts and feed (migrations 04xx)

### Tables

`posts` — spec §29 plus `parent_post_id`, `root_post_id`, `reply_count`, `reaction_count` (trigger-maintained), `reshare_of_post_id` (reserved), `status ('active'|'removed')`.
`post_media` — spec §30 with `media_object_id` FK.
`post_reactions` — spec §31, pk `(post_id, human_id)` (one reaction per Human per post; `reaction_type` text).
`post_hides` — `human_id, post_id, created_at`.

### Visibility

`earth.can_view_post(post_id, viewer_human_id)`: author self → true; `status='active'`; blocked either way → false; hidden by viewer → excluded from feeds (not from direct fetch); audience `friends` → friends only; `neighborhood` → viewer's `current_area_id` equals or is inside `posts.area_id` (`earth.area_contains`) or friends; `city` → viewer's current or home city equals post city or friends; `world` → anyone (visitors included when `PUBLIC_WORLD_ENABLED`). Replies use the root post's audience.

RLS: `posts` select via `earth.can_view_post`; writes via RPC. `post_media` follows post. `post_reactions` select when post visible; write via RPC. `post_hides` own.

### RPCs

| RPC | Caller | Behavior |
| --- | --- | --- |
| `post_create(type post_type, text, audience audience, area_id, place_id, media uuid[] (media_objects), reply_policy, reshare_policy, parent_post_id)` | human | Validates text/media presence; replies: audience forced to `min(requested, root.audience)` and `reply_policy` of root honored (`reply_not_allowed`); neighborhood/city posts take `area_id` from `human_context` when null; never stores coordinates. Rate limited. Returns `PostDto`. |
| `post_get(post_id)` | visible | `PostDto` with author, media, reactions, replies (first page). |
| `post_delete(post_id)` | author | Soft delete. |
| `post_reaction_set(post_id, reaction_type text null)` | human | Upsert/delete; notification none in V1 (likes appear lower; V1 skips push). |
| `post_hide(post_id)` | human | |
| `post_replies(post_id, cursor, limit)` | visible | |
| `feed_candidates(scope audience, area_id uuid, snapshot_at timestamptz, limit int)` | any (visitor: world only) | Candidate pool per spec §64–69, already permission-filtered; returns `FeedCandidate[]` features (see `packages/domain/src/feed/candidates.ts`) plus rendering payloads (`PostDto` / live card fields). `limit` default 200. |
| `public_feed(cursor, limit)` | visitor | Convenience wrapper over world candidates for SSR; ranking still in server tier. |

## 5. Areas, places, location, map (migrations 05xx)

### Tables

`areas` — spec §37 with `geometry geometry(MultiPolygon,4326)`, `centroid geometry(Point,4326)`, `bbox` generated, `slug unique`. Seeded: San Francisco (city, region California, country US) with neighborhoods North Beach, Mission, Dolores Heights, Hayes Valley, SoMa, Marina (approximate polygons); Oakland city; New York city with 3 neighborhoods; Los Angeles city. Seeds live in `supabase/seed/areas.sql` for dev and in a migration `0510_areas_base.sql` for the minimal SF/NY/LA cities (production needs real areas).
`places` — spec §38, `location geometry(Point,4326)`, `visibility ('public'|'private')`.
`location_shares` — spec §39.
`location_share_positions` — `share_id pk, location geometry(Point,4326), updated_at` (latest only; deleted on revoke/expiry).

### RPCs

| RPC | Caller | Behavior |
| --- | --- | --- |
| `area_resolve(lat, lng)` | any auth | Returns `{neighborhood: AreaDto|null, city: AreaDto|null}` via `ST_Contains`; does not store input. |
| `areas_search(q)` / `area_get(id)` | any | |
| `places_search(q, area_id)` / `place_get(id)` / `place_create(name, lat, lng, area_id, category)` | human | |
| `location_share_create(audience_type, audience_id, precision, duration_seconds, lat, lng)` | human | Requires `LOCATION_SHARING_ENABLED`; duration ≤ 24h (spec §75); blocks filter recipients at read time. Returns `LocationShareDto`. |
| `location_share_update(share_id, lat, lng)` | owner | Upserts latest position. |
| `location_share_revoke(share_id)` | owner | |
| `location_shares_visible()` | human | Shares the viewer may see (friend/group audience, not blocked), positions degraded by precision: `city` → city centroid, `approximate` → snapped to a 0.01° grid, `precise` → exact. |
| `map_objects(scope audience, min_lat, min_lng, max_lat, max_lng)` | any (visitor: world) | `MapObjectsDto`: live rooms (area centroid or place location per `area_precision`, never device coordinates), places, friend shares (degraded), friend moments (posts with `place_id` visible to viewer). |

## 6. Notifications and presence (migrations 06xx)

`notifications` — spec §40 (`type` = `notification_type` enum from domain). `earth.notify(recipient, type, actor, object_type, object_id, payload, priority)` skips blocked pairs and self. Realtime publication includes `notifications`.

| RPC | Caller | Behavior |
| --- | --- | --- |
| `notifications_list(cursor, limit)` | human | Ordered by priority rank then `created_at desc`; `NotificationDto[]` with title/body computed by the server tier or client from `packages/domain/notifications/copy.ts` (payload carries names). |
| `notification_mark_read(id)` / `notifications_mark_all_read()` | human | |
| `notifications_unsent(limit)` | service | For the push dispatcher: unsent rows with recipient push tokens and presence. |
| `notifications_mark_pushed(ids uuid[])` | service | |

## 7. Safety (migrations 07xx)

`reports` — spec §41 (`reason` = `report_reason` enum, `status` = `report_status` enum exactly as `REPORT_STATUS` in `packages/domain/src/enums.ts`, `severity` computed: high for threats, exploitation_minor_safety, nonconsensual_imagery, dangerous_location_stalking, violence).
`room_blocked_fingerprints` — see rooms.
`private.audit_log` — `id, actor, action, target_type, target_id, details, created_at`; written by moderator/service actions (remove participant, end room, review resolution, block).

| RPC | Caller | Behavior |
| --- | --- | --- |
| `report_create(target_type, target_id, reason report_reason, details)` | human or guest | Guests may report only rooms/participants of their room. Rate limited. |
| `reports_mine()` | human | Report history. |
| `blocks_list()` | human | Blocked Humans with identities. |

Rate limits (spec §83) applied inside RPCs: auth attempts are GoTrue's; `group_invite_create` 20/h; `room_invite_join`/`guest_session_create` 10/10min (guests 5); `message_send` 60/min; `post_create` 20/h; `friend_request_send`/`follow_set` 60/h; `report_create` 20/h; `search` 60/min; `room_start` 20/h.

## 8. Flags, settings, analytics (migrations 08xx)

`feature_flags(key text pk, enabled boolean, payload jsonb, updated_at)` — readable by all; service writes. Seeded defaults per ARCHITECTURE §12.
`app_settings(key text pk, value text)` — `public_storage_base_url`, `room_grace_seconds`, `web_origin`. Readable by all.
`analytics_events(id, human_id, anonymous_visitor_id, guest_session_id, name, properties jsonb, platform, app_version, created_at)` — insert via `analytics_track(events jsonb)` (any caller, rate limited, whitelist of names from the contract, properties stripped of coordinates) and via service; select none for clients.
`metrics_daily(day date, metric text, value numeric, dimensions jsonb, computed_at)` — `metrics_compute_daily(day date)` (service) computes spec §98–101 metrics that are derivable from first-party tables (group seed rate, humans per seed, group activation rate, second group rate, messages per active group, groups active ≥3 days/week, rooms started, rooms opened beyond group, guest joins, guest → human conversions, feed scope switches from `analytics_events`).
`rtc_diagnostics(id, human_id, guest_session_id, room_id, kind, payload, created_at)` — service insert from the diagnostics route.

## 9. Search (migrations 09xx)

`search(q text, limit int)` — `SearchResultsDto`; people ranking per spec §21 (exact handle/name match, friend, mutual count, group overlap, same city, trigram similarity), excluding blocked and hidden identities; groups only where viewer is a member; places by name; posts visible to viewer by trigram on text. Visitors search people (public profiles) and places only.

## 10. Seed (development only)

`supabase/seed/*.sql` inserts fixture auth users + Humans (Xavier, Maya, Kavon, Sarah, Ben, Chris, Alex, Sam) with `humans.is_fixture = true` (column added in 01xx, default false; production never sets it and RLS for visitors excludes fixtures when `app_settings.environment = 'production'`), friendships, two groups ("Weekend Crew", "College") with conversations and messages, world/city/friends posts, one ended room with participants, SF areas and places (Dolores Park). Seeds are applied only by `scripts/db/migrate.ts --seed` and the local stack.

## 11. Shared permission fixtures

`packages/permissions/fixtures/*.json` is the single source of truth for permission cases. Both
`packages/permissions` (TypeScript mirror) and `supabase/tests/src/permissions.test.ts` (database)
load the same files. Format:

```json
{
  "object": "post",
  "cases": [
    {
      "name": "friends post visible to friend",
      "viewer": { "kind": "human", "relationToAuthor": "friend", "sharedGroups": 0, "blockedEitherWay": false, "sameNeighborhood": false, "sameCity": false },
      "object": { "audience": "friends", "status": "active", "isReply": false },
      "expect": true
    }
  ]
}
```

Objects covered: `post` (audience × relation × block × area), `room` (visibility × join policy × relation × consent × block), `profile` (profile_visibility × relation × block), `conversation` (membership × block), `group_invite_preview` (visibility of sample members). The database test materializes each case (creates the Humans, relationships, blocks, area context, object) and asserts the RLS/RPC outcome equals `expect`; the TypeScript test asserts `canViewObject` returns `expect`.
