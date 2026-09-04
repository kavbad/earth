# @earth/api

`EarthClient` — the typed application API of `docs/architecture/ARCHITECTURE.md` §7. It is the
only place clients call `supabase.rpc`; every method:

1. validates its input with the `*InputSchema` from `@earth/domain` (or an `@earth/api` schema that
   extends one) and rejects with `EarthError('invalid_input')` — methods never throw synchronously;
2. calls the RPC named in `docs/architecture/DB_API.md` with snake_case arguments, or a `/api/*`
   route of the server tier with `Authorization: Bearer <access token>` when a session exists;
3. converts failures with `parseEarthError` — PostgREST errors carry the Earth code in `message`
   (`raise exception ... message = 'not_a_member'`), server routes answer `{ error: { code } }`;
   RLS denials (`42501`) become `forbidden`, JWT problems (`PGRST301`/`PGRST303`) become
   `not_authenticated`, unknown failures and network errors become `internal` with `details`;
4. parses the result with the DTO zod schema from `@earth/domain`; a mismatch is
   `EarthError('internal')` (a contract bug, never the caller's fault).

```ts
import { createEarthClient } from '@earth/api'

const earth = createEarthClient({ supabase, serverBaseUrl: env.API_BASE_URL, fetch })
const me = await earth.me.get()
const page = await earth.feed.page('friends')
```

`supabase` is described structurally (`SupabaseLike`: `rpc`, `from(...).select/insert`,
`storage`, `auth`) so a real `SupabaseClient` is accepted (checked at compile time in
`src/types.compat.test.ts`) and tests use `@earth/api/testing` fakes. `fetch` defaults to the
global `fetch`; `getAccessToken` defaults to `supabase.auth.getSession()`.

## The manifest

`src/manifest.ts` is the single source of truth for what every method calls. Each method is built
from a `CALLS` spec — the RPC (or route / table) it reaches, the argument names it sends and the
DTO schema it parses the result with — and `transport.call(spec, args)` only compiles when `args`
has exactly the spec's names. `RPC_MANIFEST` exports the same list without schemas:

```ts
import { RPC_MANIFEST } from '@earth/api'
// [{ method: 'posts.create', kind: 'rpc', rpc: 'post_create', route: null,
//    args: ['type', 'text', 'audience', 'area_id', 'place_id', 'media', 'reply_policy',
//           'reshare_policy', 'parent_post_id', 'provenance'], result: 'PostViewDto', ... }, ...]
```

`supabase/tests/src/verify/api-parity.test.ts` checks every RPC entry against `pg_proc` (the
function exists, every argument sent is a parameter, every parameter without a default is sent,
nothing unknown is sent) and then calls every RPC against a seeded world and parses the results
with the very schemas the client uses. `src/manifest.test.ts` checks that every namespace method
has an entry and that this README lists it.

## Method → RPC / route

Generated from `RPC_MANIFEST`. Arguments are listed as the RPC receives them (snake_case, in the
RPC's parameter order); for routes they are the query parameters (GET), the JSON body's top-level
fields (POST) or the path parameters; for direct reads, the columns. "void" means the client
ignores the RPC's result (the note says what the SQL returns); screens re-fetch or rely on
realtime. Where a list result is noted as "`{ key }` or a bare array is accepted", a JSON `null`
also reads as an empty list.

### flags, settings, me

| Method              | RPC / route / read                                         | Result         | Notes                                                  |
| ------------------- | ---------------------------------------------------------- | -------------- | ------------------------------------------------------ |
| `flags.get(…)`      | select `feature_flags` (key, enabled, payload, updated_at) | `FlagsDto`     | rows parsed with FeatureFlagRowSchema, keyed by flag   |
| `flags.resolved(…)` | select `feature_flags` (key, enabled, payload, updated_at) | `FeatureFlags` | same rows through resolveFlags (@earth/config)         |
| `settings.get(…)`   | select `app_settings` (key, value)                         | `SettingsDto`  | rows parsed with AppSettingRowSchema, keyed by setting |
| `me.get(…)`         | `me_get()`                                                 | `MeDto`        |                                                        |

### claim, identity, media

| Method                        | RPC / route / read                                                                                                           | Result                   | Notes                                                                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `claim.start(…)`              | `claim_start(intent, group_label, invite_token)`                                                                             | `ClaimStateDto`          |                                                                                                                                    |
| `claim.get(…)`                | `claim_get()`                                                                                                                | `ClaimStateDto`          |                                                                                                                                    |
| `claim.setIdentity(…)`        | `claim_set_identity(display_name, handle, avatar_media_id)`                                                                  | `ClaimStateDto`          |                                                                                                                                    |
| `claim.beginVerification(…)`  | `claim_verification_begin(provider)`                                                                                         | `VerificationBeginDto`   | provider is sent only when given (the RPC defaults it)                                                                             |
| `claim.startVerification(…)`  | `POST /api/claim/verification/start` (locale, platform, returnUrl, hint)                                                     | `VerificationSessionDto` | JSON body                                                                                                                          |
| `claim.pollVerification(…)`   | `GET /api/claim/verification/:sessionId` (sessionId)                                                                         | `VerificationResultDto`  | path parameter                                                                                                                     |
| `claim.verificationResult(…)` | `claim.pollVerification`                                                                                                     | `VerificationResultDto`  | alias                                                                                                                              |
| `claim.complete(…)`           | `claim_complete()`                                                                                                           | `ClaimCompleteDto`       |                                                                                                                                    |
| `claim.createReview(…)`       | `identity_review_create(kind, details)`                                                                                      | `IdentityReviewDto`      |                                                                                                                                    |
| `identity.update(…)`          | `identity_update(display_name, bio, avatar_media_id, profile_visibility, public_city_visibility, home_city_area_id, handle)` | `PublicIdentityDto`      | handle changes the handle (handle_invalid / handle_taken); null leaves it                                                          |
| `identity.deleteAccount(…)`   | `POST /api/account/delete`                                                                                                   | `AccountDeleteDto`       | empty JSON body; the server runs human_delete_request as the caller, then deletes the credential                                   |
| `identity.handleAvailable(…)` | `handle_available(handle)`                                                                                                   | `HandleAvailableDto`     | after case/@ normalization; a handle malformed beyond that is false without a round trip                                           |
| `identity.uploadAvatar(…)`    | `media.upload`                                                                                                               | `MediaObjectDto`         | into the avatars bucket                                                                                                            |
| `media.upload(…)`             | insert `media_objects` (owner_human_id, bucket, storage_key, content_type, width, height, duration_ms, byte_size)            | `MediaObjectDto`         | me.get for the owner, storage.from(bucket).upload(<human_id>/<random>.<ext>), then the insert (RLS: own); getPublicUrl for avatars |
| `media.signedUrl(…)`          | `storage.from(bucket).createSignedUrl`                                                                                       | `string`                 |                                                                                                                                    |

### groups

| Method                      | RPC / route / read                                                                                                      | Result                  | Notes                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------- |
| `groups.create(…)`          | `group_create(name)`                                                                                                    | `GroupDto`              |                                                                                    |
| `groups.get(…)`             | `group_get(group_id)`                                                                                                   | `GroupDetailDto`        |                                                                                    |
| `groups.update(…)`          | `group_update(group_id, name, avatar_media_id)`                                                                         | `GroupDto`              |                                                                                    |
| `groups.leave(…)`           | `group_leave(group_id)`                                                                                                 | `GroupLeaveDto`         |                                                                                    |
| `groups.invites.create(…)`  | `group_invite_create(group_id, expires_in_seconds, max_uses)`                                                           | `GroupInviteCreateDto`  |                                                                                    |
| `groups.invites.revoke(…)`  | `group_invite_revoke(invite_id)`                                                                                        | `GroupInviteRevokeDto`  |                                                                                    |
| `groups.invites.preview(…)` | `group_invite_preview(token)`                                                                                           | `GroupInvitePreviewDto` |                                                                                    |
| `groups.invites.join(…)`    | `group_invite_join(token)`                                                                                              | `GroupJoinDto`          |                                                                                    |
| `groups.invites.list(…)`    | select `group_invites_view` (id, group_id, created_by, expires_at, max_uses, use_count, status, created_at, revoked_at) | `GroupInviteDto[]`      | where group_id = ? order by created_at desc; rows parsed with GroupInviteRowSchema |
| `groups.members.remove(…)`  | `group_member_remove(group_id, human_id)`                                                                               | `GroupMemberRemoveDto`  |                                                                                    |
| `groups.members.setRole(…)` | `group_member_set_role(group_id, human_id, role)`                                                                       | `GroupMemberDto`        | moderator or member; ownership moves only through group_leave                      |

### conversations

| Method                                       | RPC / route / read                                                                   | Result                     | Notes                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------------------------- |
| `conversations.list(…)`                      | `conversations_list(cursor, limit)`                                                  | `ConversationsPageDto`     | cursor is the previous page nextCursor (a timestamptz, last_message_at)       |
| `conversations.get(…)`                       | `conversation_get(conversation_id)`                                                  | `ConversationDetailDto`    |                                                                               |
| `conversations.directWith(…)`                | `conversation_direct_get_or_create(other_human_id)`                                  | `ConversationSummaryDto`   |                                                                               |
| `conversations.createGroup(…)`               | `conversation_group_create(human_ids)`                                               | `ConversationSummaryDto`   | two or more others                                                            |
| `conversations.create(…)`                    | `conversations.directWith` → `conversations.createGroup`                             | `ConversationSummaryDto`   | one Human → directWith, more → createGroup                                    |
| `conversations.setPrefs(…)`                  | `conversation_set_prefs(conversation_id, mute_state, notification_level)`            | `ConversationPrefsDto`     |                                                                               |
| `conversations.readReceipts(…)`              | `conversation_read_receipts(conversation_id)`                                        | `ReadReceiptDto[]`         |                                                                               |
| `conversations.markRead(…)`                  | `conversation_mark_read(conversation_id, message_id)`                                | `ConversationReadStateDto` |                                                                               |
| `conversations.messages.list(…)`             | `messages_list(conversation_id, before_id, limit)`                                   | `MessagesPageDto`          |                                                                               |
| `conversations.messages.since(…)`            | `messages_since(conversation_id, after_id)`                                          | `MessageDto[]`             | { messages, nextCursor } or a bare array is accepted; a JSON null reads as [] |
| `conversations.messages.send(…)`             | `message_send(conversation_id, client_id, type, text, payload, reply_to_message_id)` | `MessageDto`               | idempotent on client_id                                                       |
| `conversations.messages.edit(…)`             | `message_edit(message_id, text)`                                                     | `MessageDto`               |                                                                               |
| `conversations.messages.delete(…)`           | `message_delete(message_id)`                                                         | `MessageDto`               | the tombstone                                                                 |
| `conversations.messages.reactions.toggle(…)` | `message_reaction_toggle(message_id, reaction)`                                      | `MessageDto`               |                                                                               |

### rooms, guest

| Method                       | RPC / route / read                                                                | Result                    | Notes                                                            |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------- |
| `rooms.start(…)`             | `room_start(context_type, context_id, title)`                                     | `RoomStartDto`            |                                                                  |
| `rooms.get(…)`               | `room_get(room_id)`                                                               | `RoomDto`                 |                                                                  |
| `rooms.join(…)`              | `room_join(room_id, media_state, consent_level)`                                  | `RoomDto`                 |                                                                  |
| `rooms.joinWithInvite(…)`    | `room_invite_join(token, media_state, consent_level)`                             | `RoomDto`                 |                                                                  |
| `rooms.setMediaState(…)`     | `room_set_media_state(room_id, media_state, consent_level)`                       | `RoomVisibilityChangeDto` | consent_level null when downgrading                              |
| `rooms.consent(…)`           | `room_consent(room_id, level)`                                                    | `RoomVisibilityChangeDto` |                                                                  |
| `rooms.setVisibility(…)`     | `room_set_visibility(room_id, visibility, join_policy)`                           | `RoomVisibilityChangeDto` |                                                                  |
| `rooms.setJoinPolicy(…)`     | `room_set_join_policy(room_id, join_policy)`                                      | `RoomDto`                 |                                                                  |
| `rooms.setGuestsDisabled(…)` | `room_set_guests_disabled(room_id, disabled)`                                     | `RoomDto`                 |                                                                  |
| `rooms.admit(…)`             | `room_admit(room_id, participant_id)`                                             | `RoomDto`                 |                                                                  |
| `rooms.leave(…)`             | `room_leave(room_id)`                                                             | `RoomLeaveDto`            |                                                                  |
| `rooms.end(…)`               | `room_end(room_id, reason)`                                                       | `RoomDto`                 |                                                                  |
| `rooms.removeParticipant(…)` | `room_remove_participant(room_id, participant_id, block_from_room)`               | `RoomDto`                 |                                                                  |
| `rooms.invites.create(…)`    | `room_invite_create(room_id, expires_in_seconds, join_policy_override)`           | `RoomInviteCreateDto`     |                                                                  |
| `rooms.invites.preview(…)`   | `room_invite_preview(token)`                                                      | `RoomInvitePreviewDto`    |                                                                  |
| `rooms.token(…)`             | `POST /api/rooms/:id/token` (id)                                                  | `RoomTokenDto`            | path parameter (room id); empty JSON body                        |
| `guest.createSession(…)`     | `guest_session_create(token, display_name, device_fingerprint_hash, media_state)` | `GuestSessionDto`         | media_state is sent only when chosen (the RPC defaults to audio) |
| `guest.get(…)`               | `guest_session_get()`                                                             | `GuestSessionsDto`        |                                                                  |

### feed, live, posts

| Method              | RPC / route / read                                                                                                      | Result                 | Notes                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------- |
| `feed.page(…)`      | `GET /api/feed` (scope, cursor, area)                                                                                   | `FeedPageDto`          | query parameters; Visitors: world                                                           |
| `live.list(…)`      | `GET /api/live` (scope, area)                                                                                           | `LiveListDto`          | query parameters                                                                            |
| `posts.create(…)`   | `post_create(type, text, audience, area_id, place_id, media, reply_policy, reshare_policy, parent_post_id, provenance)` | `PostViewDto`          | media = media object ids, provenance[i] labels media[i]; the client returns the view’s post |
| `posts.get(…)`      | `post_get(post_id)`                                                                                                     | `PostDetailDto`        |                                                                                             |
| `posts.delete(…)`   | `post_delete(post_id)`                                                                                                  | `void`                 | returns the PostViewDto tombstone                                                           |
| `posts.react(…)`    | `post_reaction_set(post_id, reaction_type)`                                                                             | `PostReactionDto`      | null clears                                                                                 |
| `posts.hide(…)`     | `post_hide(post_id)`                                                                                                    | `void`                 | returns { postId, hidden }                                                                  |
| `posts.replies(…)`  | `post_replies(post_id, cursor, limit)`                                                                                  | `PostRepliesPageDto`   | cursor is the previous page nextCursor (the last reply id); a bare array is accepted        |
| `posts.byAuthor(…)` | `posts_by_author(handle, cursor, limit)`                                                                                | `PostsByAuthorPageDto` | root posts the caller may see, newest first; cursor is the previous page nextCursor         |

### social, search, safety

| Method                    | RPC / route / read                                       | Result                  | Notes                                   |
| ------------------------- | -------------------------------------------------------- | ----------------------- | --------------------------------------- |
| `social.profile(…)`       | `profile_get(handle)`                                    | `ProfileDto`            |                                         |
| `social.friendRequest(…)` | `friend_request_send(target_human_id)`                   | `RelationshipChangeDto` |                                         |
| `social.acceptFriend(…)`  | `friend_request_accept(source_human_id)`                 | `RelationshipChangeDto` |                                         |
| `social.declineFriend(…)` | `friend_request_decline(source_human_id)`                | `RelationshipChangeDto` |                                         |
| `social.removeFriend(…)`  | `friend_remove(other_human_id)`                          | `RelationshipChangeDto` |                                         |
| `social.setFollow(…)`     | `follow_set(target_human_id, following)`                 | `RelationshipChangeDto` |                                         |
| `social.block(…)`         | `block_set(target_human_id, blocked)`                    | `BlockChangeDto`        | blocked = true                          |
| `social.unblock(…)`       | `block_set(target_human_id, blocked)`                    | `BlockChangeDto`        | blocked = false                         |
| `social.blocks(…)`        | `blocks_list()`                                          | `BlocksListDto`         | a bare array is accepted                |
| `search.query(…)`         | `search(q, limit)`                                       | `SearchResultsDto`      |                                         |
| `safety.report(…)`        | `report_create(target_type, target_id, reason, details)` | `ReportDto`             |                                         |
| `safety.myReports(…)`     | `reports_mine()`                                         | `ReportDto[]`           | { reports } or a bare array is accepted |

### notifications, presence

| Method                               | RPC / route / read                                  | Result                 | Notes                                     |
| ------------------------------------ | --------------------------------------------------- | ---------------------- | ----------------------------------------- |
| `notifications.list(…)`              | `notifications_list(cursor, limit)`                 | `NotificationsPageDto` |                                           |
| `notifications.markRead(…)`          | `notification_mark_read(id)`                        | `void`                 | returns the notification row without copy |
| `notifications.markAllRead(…)`       | `notifications_mark_all_read()`                     | `void`                 | returns { markedCount, unreadCount }      |
| `notifications.unreadCount(…)`       | `notifications_unread_count()`                      | `UnreadCountDto`       | the client returns the number             |
| `notifications.registerPushToken(…)` | `push_token_register(token, platform)`              | `void`                 | returns { token, platform, updatedAt }    |
| `notifications.removePushToken(…)`   | `push_token_remove(token)`                          | `void`                 | returns { removed }                       |
| `presence.ping(…)`                   | `presence_ping(conversation_id, room_id, platform)` | `void`                 | returns the presence row                  |

### location, places, map

| Method                             | RPC / route / read                                                                         | Result               | Notes                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------ | -------------------- | -------------------------------------------------------------------------- |
| `location.resolveArea(…)`          | `area_resolve(lat, lng)`                                                                   | `AreaResolutionDto`  | the position is never stored                                               |
| `location.searchAreas(…)`          | `areas_search(q)`                                                                          | `AreaDto[]`          | { areas } or a bare array is accepted                                      |
| `location.getArea(…)`              | `area_get(id)`                                                                             | `AreaDto`            |                                                                            |
| `location.setContext(…)`           | `context_set(current_area_id, current_city_id, home_city_id)`                              | `HumanContextDto`    | only ids, never coordinates                                                |
| `location.resolveAndSetContext(…)` | `context_resolve_and_set(lat, lng)`                                                        | `HumanContextDto`    | resolves and stores the area ids in one call; the position is never stored |
| `location.setScope(…)`             | `scope_set(surface, scope)`                                                                | `void`               | returns { surface, scope }                                                 |
| `location.share(…)`                | `location_share_create(audience_type, audience_id, precision, duration_seconds, lat, lng)` | `LocationShareDto`   |                                                                            |
| `location.updateShare(…)`          | `location_share_update(share_id, lat, lng)`                                                | `LocationShareDto`   |                                                                            |
| `location.revokeShare(…)`          | `location_share_revoke(share_id)`                                                          | `LocationShareDto`   |                                                                            |
| `location.visibleShares(…)`        | `location_shares_visible()`                                                                | `MapFriendDto[]`     | { shares } or a bare array is accepted                                     |
| `location.myShares(…)`             | `location_shares_mine()`                                                                   | `LocationShareDto[]` | the caller’s live shares; { shares } or a bare array is accepted           |
| `places.search(…)`                 | `places_search(q, area_id)`                                                                | `PlaceDto[]`         | { places } or a bare array is accepted                                     |
| `places.get(…)`                    | `place_get(id)`                                                                            | `PlaceDto`           |                                                                            |
| `places.create(…)`                 | `place_create(name, lat, lng, area_id, category)`                                          | `PlaceDto`           |                                                                            |
| `map.objects(…)`                   | `map_objects(scope, min_lat, min_lng, max_lat, max_lng)`                                   | `MapObjectsDto`      | bbox [west, south, east, north] → min_lng, min_lat, max_lng, max_lat       |

### analytics, diagnostics

| Method                | RPC / route / read                               | Result | Notes                             |
| --------------------- | ------------------------------------------------ | ------ | --------------------------------- |
| `analytics.ingest(…)` | `POST /api/analytics/ingest` (v, sentAt, events) | `void` | JSON body (AnalyticsIngestBatch)  |
| `diagnostics.rtc(…)`  | `POST /api/diagnostics/rtc` (v, ts, event)       | `void` | JSON body (RtcDiagnosticEnvelope) |

`accessToken()` returns the caller's Supabase access token (`null` for Visitors) for the
`@earth/analytics` / `@earth/observability` sinks; `transport` exposes `call` / `route` (manifest
specs) and `rpc` / `server` for packages that add a route without re-implementing error handling.

### Server-tier RPCs (no client method by design)

`SERVER_TIER_RPCS` lists the `public` functions the client never calls (ARCHITECTURE §6): they are
reached through their `/api/*` routes (`rooms.token` → `room_media_grant`, `feed.page` →
`feed_candidates` / `public_feed`, `live.list` → `live_candidates`, `analytics.ingest` →
`analytics_track`, `diagnostics.rtc` → `rtc_diagnostic_record`, the claim verification routes →
`human_pass_record_result`, `identity.deleteAccount` → `human_delete_request` followed by the
admin-API credential deletion), by the LiveKit webhook (`room_participant_sync`), by cron
(`rooms_sweep`, `notifications_unsent`, `notifications_mark_pushed`, `notifications_prune`,
`metrics_compute_daily`) or by operators (`report_resolve`). The parity test fails when a `public`
RPC is in neither list.

## Realtime factories

`@earth/realtime` subscriptions take closures instead of a client:

```ts
import { createRealtimeFactories } from '@earth/api'

const rt = createRealtimeFactories(earth)
subscribeConversation({ supabase, conversationId, fetchSince: rt.fetchSince(conversationId), ... })
subscribeRoom({ supabase, roomId, fetchState: rt.fetchState(roomId), ... })
createPresencePinger({ presencePing: rt.presencePing, foregrounded })
```

## Testing

`@earth/api/testing` exports `createFakeSupabase` (records `rpc` calls, table queries, storage
uploads; programmable results, `postgrestRaise(code)` builds the PostgREST error shape),
`createFakeFetch` (records requests, programmable status/body), `createTestClient` (an
`EarthClient` on both fakes) and `fixtures` (wire-shaped DTO builders for every DTO the client
parses). Nothing in this package touches the network or a database.

## Contract notes

- `post_create` takes `media uuid[]` and `provenance media_provenance[]` (DB_API §4): each media
  item carries the `mediaObjectId` registered by `media.upload` and its `provenance`, sent
  position-aligned; dimensions and `clientId` are validated client-side but not sent (the RPC has no
  such arguments). The RPC answers `PostViewDto` (`earth.post_json`); `posts.create` returns its
  `post`.
- `conversations.messages.edit` / `delete` / `reactions.toggle` return the updated `MessageDto`
  (the tombstone for a delete) and `conversations.markRead` the caller's read state, exactly as the
  RPCs answer them; `posts.react` returns `{ postId, myReaction, reactionCount }`.
- `rooms.setJoinPolicy` / `setGuestsDisabled` / `admit` / `end` / `removeParticipant` return the
  `RoomDto` afterwards; `location.updateShare` / `revokeShare` the `LocationShareDto`.
- `location.resolveAndSetContext` is one RPC, `context_resolve_and_set(lat, lng)`, answering the
  `HumanContextDto` it stored; `notifications.unreadCount` is `notifications_unread_count()`.
- `conversations_list` keys its page on `last_message_at`: the `cursor` argument is a `timestamptz`
  and `nextCursor` carries it as an ISO string; `notifications_list` and `post_replies` cursors
  are text (a notification cursor, the last reply's id).
- Results DB_API.md describes without a `@earth/domain` DTO are typed in `src/dto.ts`
  (`IdentityReviewDto`, `GroupInviteDto`, `GroupLeaveDto`, `ReadReceiptDto`,
  `ConversationPrefsDto`, `ConversationReadStateDto`, `PostReactionDto`, `UnreadCountDto`,
  `GuestSessionsDto`, `AreaResolutionDto`, `BlockChangeDto`, ...), matching the shapes the
  migrations return.
- `GET /api/claim/verification/:sessionId` answers `VerificationResultDto`
  (`{ sessionId, status, failureKind }`), not the start route's `VerificationSessionDto`;
  `failureKind` values are owned by `@earth/auth` (`VERIFICATION_FAILURE_KINDS`), which depends on
  this package, so the DTO types them as a non-empty string.
