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

## Method → RPC / route

Arguments are listed as the RPC receives them. "void" means the RPC's result is not part of the
contract (DB_API.md names no DTO); the client only surfaces errors and screens re-fetch or rely on
realtime. `[]|{key}` means a bare array or `{ key: [...] }` is accepted (and a JSON `null` reads as
an empty list).

### flags, settings, me

| Method             | RPC / read                                                | Result                   |
| ------------------ | --------------------------------------------------------- | ------------------------ |
| `flags.get()`      | `select feature_flags(key, enabled, payload, updated_at)` | `FlagsDto`               |
| `flags.resolved()` | same rows through `resolveFlags` (`@earth/config`)        | `FeatureFlags`           |
| `settings.get()`   | `select app_settings(key, value)`                         | `Record<string, string>` |
| `me.get()`         | `me_get()`                                                | `MeDto`                  |

### claim, identity, media

| Method                                                                                                                | RPC / route                                                                                                                              | Result                     |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `claim.start({ intent, groupLabel?, inviteToken? })`                                                                  | `claim_start(intent, group_label, invite_token)`                                                                                         | `ClaimStateDto`            |
| `claim.get()`                                                                                                         | `claim_get()`                                                                                                                            | `ClaimStateDto`            |
| `claim.setIdentity({ displayName, handle, avatarMediaId? })`                                                          | `claim_set_identity(display_name, handle, avatar_media_id)`                                                                              | `ClaimStateDto`            |
| `claim.beginVerification(provider?)`                                                                                  | `claim_verification_begin(provider)`                                                                                                     | `{ humanPassId, status? }` |
| `claim.startVerification({ locale?, platform, returnUrl?, hint? })`                                                   | `POST /api/claim/verification/start` (bearer required)                                                                                   | `VerificationSessionDto`   |
| `claim.pollVerification(sessionId)` (alias `verificationResult`)                                                      | `GET /api/claim/verification/:sessionId` (bearer required)                                                                               | `VerificationResultDto`    |
| `claim.complete()`                                                                                                    | `claim_complete()`                                                                                                                       | `ClaimCompleteDto`         |
| `claim.createReview({ kind, details? })`                                                                              | `identity_review_create(kind, details)`                                                                                                  | `IdentityReviewDto`        |
| `identity.update({ displayName?, bio?, avatarMediaId?, profileVisibility?, publicCityVisibility?, homeCityAreaId? })` | `identity_update(display_name, bio, avatar_media_id, profile_visibility, public_city_visibility, home_city_area_id)`                     | `PublicIdentityDto`        |
| `identity.handleAvailable(handle)`                                                                                    | `handle_available(handle)` after case/`@` normalization (still malformed → `false` locally)                                              | `boolean`                  |
| `identity.uploadAvatar({ body, contentType, width?, height?, byteSize? })`                                            | `media.upload` into the `avatars` bucket                                                                                                 | `MediaObjectDto`           |
| `media.upload(body, { bucket, contentType, width?, height?, durationMs?, byteSize? })`                                | `me_get()` → `storage.from(bucket).upload(<human_id>/<random>.<ext>)` → `insert media_objects` (RLS: own) → `getPublicUrl` for `avatars` | `MediaObjectDto`           |
| `media.signedUrl(bucket, storageKey, expiresInSeconds?)`                                                              | `storage.from(bucket).createSignedUrl`                                                                                                   | `string`                   |

### groups

| Method                                                                     | RPC / read                                                              | Result                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ----------------------- |
| `groups.create({ name? })`                                                 | `group_create(name)`                                                    | `GroupDto`              |
| `groups.get(groupId)`                                                      | `group_get(group_id)`                                                   | `GroupDetailDto`        |
| `groups.update({ groupId, name?, avatarMediaId? })`                        | `group_update(group_id, name, avatar_media_id)`                         | `GroupDto`              |
| `groups.leave(groupId)`                                                    | `group_leave(group_id)`                                                 | `GroupLeaveDto`         |
| `groups.invites.create({ groupId, expiresInHours?, maxUses? })`            | `group_invite_create(group_id, expires_in_seconds, max_uses)`           | `GroupInviteCreateDto`  |
| `groups.invites.revoke(inviteId)`                                          | `group_invite_revoke(invite_id)`                                        | `GroupInviteRevokeDto`  |
| `groups.invites.preview(token)`                                            | `group_invite_preview(token)`                                           | `GroupInvitePreviewDto` |
| `groups.invites.join(token)`                                               | `group_invite_join(token)`                                              | `GroupJoinDto`          |
| `groups.invites.list(groupId)`                                             | `select group_invites_view where group_id = ? order by created_at desc` | `GroupInviteDto[]`      |
| `groups.members.remove(groupId, humanId)`                                  | `group_member_remove(group_id, human_id)`                               | `GroupMemberRemoveDto`  |
| `groups.members.setRole(groupId, humanId, role)` (`moderator` \| `member`) | `group_member_set_role(group_id, human_id, role)`                       | `GroupMemberDto`        |

### conversations

| Method                                                                                              | RPC                                                                                  | Result                   |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| `conversations.list({ cursor?, limit? })`                                                           | `conversations_list(cursor, limit)`                                                  | `ConversationsPageDto`   |
| `conversations.get(conversationId)`                                                                 | `conversation_get(conversation_id)`                                                  | `ConversationDetailDto`  |
| `conversations.directWith(humanId)`                                                                 | `conversation_direct_get_or_create(other_human_id)`                                  | `ConversationSummaryDto` |
| `conversations.createGroup(humanIds)` (≥ 2)                                                         | `conversation_group_create(human_ids)`                                               | `ConversationSummaryDto` |
| `conversations.create({ humanIds })`                                                                | one → `directWith`, more → `createGroup`                                             | `ConversationSummaryDto` |
| `conversations.setPrefs({ conversationId, muteState?, notificationLevel? })`                        | `conversation_set_prefs(conversation_id, mute_state, notification_level)`            | `ConversationPrefsDto`   |
| `conversations.readReceipts(conversationId)`                                                        | `conversation_read_receipts(conversation_id)`                                        | `ReadReceiptDto[]`       |
| `conversations.markRead({ conversationId, lastReadMessageId })`                                     | `conversation_mark_read(conversation_id, message_id)`                                | void                     |
| `conversations.messages.list({ conversationId, beforeId?, limit? })`                                | `messages_list(conversation_id, before_id, limit)`                                   | `MessagesPageDto`        |
| `conversations.messages.since({ conversationId, afterId })`                                         | `messages_since(conversation_id, after_id)`                                          | `MessageDto[]` (`[]      | {messages}`) |
| `conversations.messages.send({ conversationId, clientId, type, text, payload?, replyToMessageId })` | `message_send(conversation_id, client_id, type, text, payload, reply_to_message_id)` | `MessageDto`             |
| `conversations.messages.edit({ messageId, text })`                                                  | `message_edit(message_id, text)`                                                     | void                     |
| `conversations.messages.delete(messageId)`                                                          | `message_delete(message_id)`                                                         | void                     |
| `conversations.messages.reactions.toggle({ messageId, reaction })`                                  | `message_reaction_toggle(message_id, reaction)`                                      | void                     |

### rooms, guest

| Method                                                                                   | RPC / route                                                                                                                 | Result                    |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `rooms.start({ contextType, contextId, title? })`                                        | `room_start(context_type, context_id, title)`                                                                               | `RoomStartDto`            |
| `rooms.get(roomId)`                                                                      | `room_get(room_id)`                                                                                                         | `RoomDto`                 |
| `rooms.join({ roomId, mediaState, consentLevel })`                                       | `room_join(room_id, media_state, consent_level)`                                                                            | `RoomDto`                 |
| `rooms.joinWithInvite({ token, mediaState, consentLevel })`                              | `room_invite_join(token, media_state, consent_level)`                                                                       | `RoomDto`                 |
| `rooms.setMediaState({ roomId, mediaState, consentLevel? })`                             | `room_set_media_state(room_id, media_state, consent_level)`                                                                 | `RoomVisibilityChangeDto` |
| `rooms.consent({ roomId, level })`                                                       | `room_consent(room_id, level)`                                                                                              | `RoomVisibilityChangeDto` |
| `rooms.setVisibility({ roomId, visibility, joinPolicy })`                                | `room_set_visibility(room_id, visibility, join_policy)`                                                                     | `RoomVisibilityChangeDto` |
| `rooms.setJoinPolicy({ roomId, joinPolicy })`                                            | `room_set_join_policy(room_id, join_policy)`                                                                                | void                      |
| `rooms.setGuestsDisabled({ roomId, disabled })`                                          | `room_set_guests_disabled(room_id, disabled)`                                                                               | void                      |
| `rooms.admit({ roomId, participantId })`                                                 | `room_admit(room_id, participant_id)`                                                                                       | void                      |
| `rooms.leave(roomId)`                                                                    | `room_leave(room_id)`                                                                                                       | `RoomLeaveDto`            |
| `rooms.end({ roomId, reason? })`                                                         | `room_end(room_id, reason)`                                                                                                 | void                      |
| `rooms.removeParticipant({ roomId, participantId, blockFromRoom? })`                     | `room_remove_participant(room_id, participant_id, block_from_room)`                                                         | void                      |
| `rooms.invites.create({ roomId, expiresInMinutes?, joinPolicyOverride? })`               | `room_invite_create(room_id, expires_in_seconds, join_policy_override)`                                                     | `RoomInviteCreateDto`     |
| `rooms.invites.preview(token)`                                                           | `room_invite_preview(token)`                                                                                                | `RoomInvitePreviewDto`    |
| `rooms.token(roomId)`                                                                    | `POST /api/rooms/:id/token` (bearer required)                                                                               | `RoomTokenDto`            |
| `guest.createSession({ inviteToken, displayName, deviceFingerprintHash?, mediaState? })` | `guest_session_create(token, display_name, device_fingerprint_hash[, media_state])` — `media_state` is sent only when given | `GuestSessionDto`         |
| `guest.get()`                                                                            | `guest_session_get()`                                                                                                       | `GuestSessionsDto`        |

### feed, live, posts

| Method                                                                                                                                                  | RPC / route                                                                                                                           | Result                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `feed.page(scope, cursor?, areaId?)`                                                                                                                    | `GET /api/feed?scope=&cursor=&area=` (bearer optional; Visitors: `world`)                                                             | `FeedPageDto`                                   |
| `live.list(scope, areaId?)`                                                                                                                             | `GET /api/live?scope=&area=` (bearer optional)                                                                                        | `LiveListDto`                                   |
| `posts.create({ type, text, audience, placeId, media: [{ mediaObjectId, ...PostMediaInput }], replyPolicy?, resharePolicy?, parentPostId, clientId? })` | `post_create(type, text, audience, area_id = null, place_id, media = media object ids, reply_policy, reshare_policy, parent_post_id)` | `PostDto` (a `PostViewDto` result is unwrapped) |
| `posts.get(postId)`                                                                                                                                     | `post_get(post_id)`                                                                                                                   | `PostDetailDto`                                 |
| `posts.delete(postId)`                                                                                                                                  | `post_delete(post_id)`                                                                                                                | void                                            |
| `posts.react({ postId, reaction })` (`null` clears)                                                                                                     | `post_reaction_set(post_id, reaction_type)`                                                                                           | void                                            |
| `posts.hide(postId)`                                                                                                                                    | `post_hide(post_id)`                                                                                                                  | void                                            |
| `posts.replies({ postId, cursor?, limit? })`                                                                                                            | `post_replies(post_id, cursor, limit)`                                                                                                | `PostRepliesPageDto` (`[]` accepted)            |

### social, search, safety

| Method                                                     | RPC                                                      | Result                          |
| ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------- |
| `social.profile(handle)` (`@Maya` → `maya`)                | `profile_get(handle)`                                    | `ProfileDto`                    |
| `social.friendRequest(humanId)`                            | `friend_request_send(target_human_id)`                   | `RelationshipChangeDto`         |
| `social.acceptFriend(humanId)`                             | `friend_request_accept(source_human_id)`                 | `RelationshipChangeDto`         |
| `social.declineFriend(humanId)`                            | `friend_request_decline(source_human_id)`                | `RelationshipChangeDto`         |
| `social.removeFriend(humanId)`                             | `friend_remove(other_human_id)`                          | `RelationshipChangeDto`         |
| `social.setFollow(humanId, following)`                     | `follow_set(target_human_id, following)`                 | `RelationshipChangeDto`         |
| `social.block(humanId)` / `social.unblock(humanId)`        | `block_set(target_human_id, blocked)`                    | `BlockChangeDto`                |
| `social.blocks()`                                          | `blocks_list()`                                          | `BlocksListDto` (`[]` accepted) |
| `search.query(q, limit?)`                                  | `search(q, limit)`                                       | `SearchResultsDto`              |
| `safety.report({ targetType, targetId, reason, details })` | `report_create(target_type, target_id, reason, details)` | `ReportDto`                     |
| `safety.myReports()`                                       | `reports_mine()`                                         | `ReportDto[]` (`[]              | {reports}`) |

### notifications, presence

| Method                                                   | RPC                                                 | Result                 |
| -------------------------------------------------------- | --------------------------------------------------- | ---------------------- |
| `notifications.list({ cursor?, limit? })`                | `notifications_list(cursor, limit)`                 | `NotificationsPageDto` |
| `notifications.markRead(id)`                             | `notification_mark_read(id)`                        | void                   |
| `notifications.markAllRead()`                            | `notifications_mark_all_read()`                     | void                   |
| `notifications.unreadCount()`                            | `notifications_list(null, 1).unreadCount`           | `number`               |
| `notifications.registerPushToken({ token, platform })`   | `push_token_register(token, platform)`              | void                   |
| `notifications.removePushToken(token)`                   | `push_token_remove(token)`                          | void                   |
| `presence.ping({ conversationId?, roomId?, platform? })` | `presence_ping(conversation_id, room_id, platform)` | void                   |

### location, places, map

| Method                                                                               | RPC                                                                                        | Result                |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------- |
| `location.resolveArea({ lat, lng })`                                                 | `area_resolve(lat, lng)`                                                                   | `AreaResolutionDto`   |
| `location.searchAreas(q)`                                                            | `areas_search(q)`                                                                          | `AreaDto[]` (`[]      | {areas}`)  |
| `location.getArea(areaId)`                                                           | `area_get(id)`                                                                             | `AreaDto`             |
| `location.setContext({ currentAreaId?, currentCityId?, homeCityId? })`               | `context_set(current_area_id, current_city_id, home_city_id)`                              | `HumanContextDto`     |
| `location.resolveAndSetContext({ lat, lng })`                                        | `area_resolve` then `context_set` with the resolved ids                                    | `AreaResolutionDto`   |
| `location.setScope({ surface, scope })`                                              | `scope_set(surface, scope)`                                                                | void                  |
| `location.share({ audienceType, audienceId, precision, durationMinutes, position })` | `location_share_create(audience_type, audience_id, precision, duration_seconds, lat, lng)` | `LocationShareDto`    |
| `location.updateShare({ shareId, position })`                                        | `location_share_update(share_id, lat, lng)`                                                | void                  |
| `location.revokeShare(shareId)`                                                      | `location_share_revoke(share_id)`                                                          | void                  |
| `location.visibleShares()`                                                           | `location_shares_visible()`                                                                | `MapFriendDto[]` (`[] | {shares}`) |
| `places.search({ q, areaId? })`                                                      | `places_search(q, area_id)`                                                                | `PlaceDto[]` (`[]     | {places}`) |
| `places.get(placeId)`                                                                | `place_get(id)`                                                                            | `PlaceDto`            |
| `places.create({ name, position, areaId, category? })`                               | `place_create(name, lat, lng, area_id, category)`                                          | `PlaceDto`            |
| `map.objects(scope, [west, south, east, north])`                                     | `map_objects(scope, min_lat, min_lng, max_lat, max_lng)`                                   | `MapObjectsDto`       |

### analytics, diagnostics

| Method                      | Route                                          | Result |
| --------------------------- | ---------------------------------------------- | ------ |
| `analytics.ingest(batch)`   | `POST /api/analytics/ingest` (bearer optional) | void   |
| `diagnostics.rtc(envelope)` | `POST /api/diagnostics/rtc` (bearer optional)  | void   |

`accessToken()` returns the caller's Supabase access token (`null` for Visitors) for the
`@earth/analytics` / `@earth/observability` sinks; `transport` exposes `rpc` / `server` for packages
that add a route without re-implementing error handling.

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

- `post_create` takes `media uuid[]` (DB_API §4), so each media item carries the `mediaObjectId`
  registered by `media.upload`; `provenance`, dimensions and `clientId` are validated client-side
  but not sent (the RPC has no such arguments).
- Results DB_API.md describes without a `@earth/domain` DTO are typed in `src/dto.ts`
  (`IdentityReviewDto`, `GroupInviteDto`, `GroupLeaveDto`, `ReadReceiptDto`,
  `ConversationPrefsDto`, `GuestSessionsDto`, `AreaResolutionDto`, ...), matching the shapes the
  migrations under `supabase/migrations/018x` already return.
- `GET /api/claim/verification/:sessionId` answers `VerificationResultDto`
  (`{ sessionId, status, failureKind }`), not the start route's `VerificationSessionDto`;
  `failureKind` values are owned by `@earth/auth` (`VERIFICATION_FAILURE_KINDS`), which depends on
  this package, so the DTO types them as a non-empty string.
- Server-tier RPCs (`room_media_grant`, `feed_candidates`, `live_candidates`, `analytics_track`,
  `human_pass_record_result`, `room_participant_sync`, `rooms_sweep`, `notifications_unsent`,
  `notifications_mark_pushed`, `metrics_compute_daily`, `public_feed`) are reached through their
  `/api/*` routes (`rooms.token`, `feed.page`, `live.list`, `analytics.ingest`, ...) or by cron —
  they have no client method by design (ARCHITECTURE §6).
