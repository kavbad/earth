# EARTH V1 — Product Requirements Document + End-to-End Build Specification

Canonical implementation handoff. This file is the product source of truth for the V1 build.
Implementation agents: read the PART relevant to your task before writing code.

- Product: Earth
- Positioning: The social network for real life.
- V1 objective: Prove that real existing groups prefer Earth for messaging/video, ordinary Humans casually go Live for friends, and those Humans naturally bring additional groups.
- Platforms: iOS, Android, web guest/public surfaces.
- Canonical aesthetic: white, simple, timeless, human, spatial, permanent.

---

## PART I — BUILD MANDATE

### 1. What you are building

Build a real, end-to-end, deployable V1 of Earth. Earth is simultaneously:

- a world-class group messenger
- a world-class private/group video product
- a casual social Live product
- a social feed
- a lightweight geographic/social map
- a Human identity network

The product must feel like one application, not six products joined together.

The fundamental launch loop is:

existing group → Earth chat → group video → casual Live → overlapping friends join → more groups migrate

The universal public experience ensures Earth is useful even before someone's social graph is dense.

### 2. V1 success condition

V1 succeeds only if all three behaviors occur organically:

- A. Group substitution — A real existing group chooses Earth instead of its prior messaging thread for meaningful communication.
- B. Casual Live — A normal person goes Live while doing something ordinary because friends may join.
- C. Second-group propagation — A Human who joined Earth through one group independently brings another real group.

Everything built in V1 must support these behaviors.

### 3. Do not build a mockup

The implementation must include: real persistent users, real database, real authentication, real group membership, real messaging, real realtime message updates, real video calling, real guest room links, real push notifications, real feed data, real posting, real privacy permissions, real moderation controls, real map, real deployment configuration, automated tests, analytics instrumentation.

No screen should exist solely as a visual placeholder unless this specification explicitly says scaffold only.

### 4. What NOT to build yet

V1 does not need: full Personal Earth lifetime archive, sophisticated memory reconstruction, decentralized protocol, developer SDK, full Activities marketplace, sophisticated geographic chat hierarchy, creator monetization, advertising, payments, reservations, advanced Pages, professional livestream studio, sophisticated recommendation ML, contact import, full organization accounts, public event aggregation, global multi-camera breaking-news infrastructure.

Architect for them where explicitly noted. Do not expose their complexity.

---

## PART II — REFERENCE IMPLEMENTATION STACK

### 5. Repository

TypeScript monorepo:

```text
earth/
  apps/
    mobile/
    web/
  packages/
    api/
    auth/
    domain/
    ui/
    analytics/
    config/
    permissions/
    realtime/
  supabase/
    migrations/
    functions/
    seed/
    tests/
  docs/
    architecture/
    product/
  e2e/
  package.json
  turbo.json
  pnpm-workspace.yaml
```

Use: pnpm, Turborepo, strict TypeScript, ESLint, Prettier, environment validation.

No business logic should be duplicated between mobile and web when it can live in a shared domain package.

### 6. Mobile

React Native + Expo. One mobile application for iOS and Android. Current stable Expo-compatible packages.

Required native capabilities: camera, microphone, notifications, secure credentials, image picker, location, deep links, haptics, background audio where supported.

Do not build separate Swift/Kotlin applications for V1.

### 7. Web

React/Next.js web application for: public World browsing, shared post/profile links, group invitation preview, Guest Live room participation, eventual account handoff to mobile/web claim flow.

The most important web flow is: shared room link → camera/mic permission → Guest joins immediately.

The web application must be responsive and mobile-browser friendly.

### 8. Database / backend

PostgreSQL via Supabase. Use Supabase for: Postgres, authentication primitives, file storage, realtime events/presence where appropriate, server-side functions, database migrations.

Every exposed table must use explicit authorization. Private tables must not accidentally inherit anonymous access. All sensitive mutations must occur through server-side functions where direct client writes would weaken invariants.

### 9. Realtime video

LiveKit powers: 1:1 video, group video, Guest rooms, Live rooms, room participant state, audio, screen share where supported.

Earth owns the social room model. LiveKit is the media transport. Do not make LiveKit's room semantics the canonical Earth data model. Every LiveKit room maps to an Earth `room_id`. Earth permissions are evaluated before issuing LiveKit access tokens.

### 10. Media

Supabase Storage for images, voice messages, attachments, profile photographs.

For uploaded feed video, create a `VideoProvider` abstraction. V1 can initially use object storage if playback quality is acceptable. The interface must allow migration to a dedicated video-transcoding/CDN provider without changing Post/PostMedia domain objects.

### 11. Maps

Production-capable native/web map provider through a thin `MapProvider` abstraction. V1 needs: interactive map, user location when permitted, approximate friend/location representation, public Live clusters, place pins, zoom behavior.

Earth's own social data model must remain independent of the map vendor.

### 12. Push notifications

Mobile push must support iOS APNs and Android FCM. Use Expo's notification tooling where practical. Server creates canonical notification records first. Push delivery is an output channel, not the notification source of truth.

### 13. Analytics

Instrument every important action. Use an analytics provider through a shared adapter. Required abilities: identify Human, anonymous visitor ID, Guest session ID, event capture, properties, funnel analysis.

Also persist the handful of mission-critical network metrics in first-party database tables/jobs so Earth is not entirely dependent on one analytics vendor.

### 14. Error monitoring

Integrate: runtime exception monitoring, release/version tracking, server-function error logging, RTC connection diagnostics. Every realtime/video failure must emit diagnostic data.

### 15. Human verification

```ts
interface HumanVerificationProvider {
  startVerification(input): Promise<VerificationSession>
  getVerificationResult(sessionId): Promise<VerificationResult>
}
```

Production Human membership must not silently fall back to a fake verification state. Development may use a mock provider. Production must have a configured liveness/uniqueness provider or manual-review path.

Preferred model: liveness, uniqueness/deduplication, device/account risk, fallback manual review.

Do not build homemade face-recognition infrastructure into the social application layer. The application treats Human verification as an external high-assurance boundary.

---

## PART III — CANONICAL DOMAIN MODEL

### 16. Human — `humans`

```text
id UUID PK
status ENUM: pending | active | restricted | suspended | deleted
human_pass_status ENUM: unverified | verifying | verified | review_required | rejected
created_at
claimed_at
deleted_at
last_active_at
```

A Human is the permanent underlying person object. Public name/avatar do not live directly on this table.

### 17. Public identity — `public_identities`

```text
human_id UUID PK/FK
display_name
handle UNIQUE
bio nullable
avatar_media_id nullable
home_city_area_id nullable
public_city_visibility boolean
profile_visibility ENUM: public | limited | hidden
created_at
updated_at
```

Public identity can change. Human ID remains stable.

### 18. Human access identities — `auth_identities`

```text
id
human_id
provider
provider_subject
verified_at
created_at
revoked_at
```

Examples: phone, email, Apple, Google, passkey. Do not equate authentication credential with Human identity.

### 19. Human Pass — `human_passes`

```text
id
human_id
provider
provider_reference
status
risk_level
verified_at
reviewed_at
metadata_private JSONB
```

Access to `metadata_private` must be service-only. Never expose biometric/provider details through public APIs.

### 20. Relationships — `relationships`

```text
id
source_human_id
target_human_id
type ENUM: follow | friend_pending | friend | familiar_private
created_at
updated_at
```

Rules: Follow is directional. Friend is mutual. Store friendship canonically or maintain paired edges transactionally. `familiar_private` is not visible to the target.

### 21. Blocks — `blocks`

```text
blocker_human_id
blocked_human_id
created_at
```

Blocking must override: feed eligibility, search visibility, Live discovery, messaging, friend suggestions, location visibility, notifications. No feature may bypass block state.

### 22. Groups — `groups`

```text
id
created_by_human_id
name nullable
avatar_media_id nullable
kind ENUM: persistent | temporary
status
created_at
last_activity_at
```

A group exists even without a name.

### 23. Group membership — `group_members`

```text
group_id
human_id
role ENUM: owner | moderator | member
status ENUM: active | left | removed
joined_at
```

Joining a group does not automatically create friendship.

### 24. Group invitations — `group_invites`

```text
id
group_id
created_by
token_hash
expires_at nullable
max_uses nullable
use_count
status
created_at
```

Public invite preview exposes: group name if present, overlapping member names/photos allowed by privacy, member count. Do not expose private messages before membership.

### 25. Conversations — `conversations`

```text
id
type ENUM: direct | group
group_id nullable
created_at
last_message_at
```

One group has one canonical primary conversation in V1.

### 26. Conversation membership — `conversation_members`

```text
conversation_id
human_id
joined_at
last_read_message_id nullable
mute_state
notification_level
```

### 27. Messages — `messages`

```text
id
conversation_id
sender_human_id
type ENUM: text | image | video | audio | file | poll | system | place | plan
text nullable
reply_to_message_id nullable
payload JSONB
created_at
edited_at nullable
deleted_at nullable
```

Deletion should preserve minimal tombstone metadata necessary for thread integrity.

### 28. Message reactions — `message_reactions`

```text
message_id
human_id
reaction
created_at
```

Unique by message/human/reaction.

### 29. Posts — `posts`

```text
id
author_human_id
type ENUM: text | image | video | moment
text nullable
audience ENUM: friends | neighborhood | city | world
area_id nullable
place_id nullable
reply_policy ENUM: everyone_eligible | friends | mentioned | none
reshare_policy ENUM: allowed_within_audience | none
created_at
edited_at
deleted_at
```

Important: `audience` describes who the author intended to reach. It is not merely ranking metadata.

### 30. Post media — `post_media`

```text
id
post_id
media_type
storage_key/provider_id
width
height
duration_ms nullable
provenance ENUM: earth_capture | uploaded | edited | unknown
created_at
```

### 31. Post interactions

`post_reactions`:

```text
post_id
human_id
reaction_type
created_at
```

`post_replies`: Replies use Posts with `parent_post_id nullable`, `root_post_id nullable`. Audience cannot exceed the root object's audience.

### 32. Rooms — `rooms`

```text
id
context_type ENUM: direct | group | event | place | standalone
context_id nullable
initiated_by_human_id
visibility ENUM: invited | group | friends | extended | neighborhood | city | world
join_policy ENUM: invited_only | group | friends | friends_of_friends | request | anyone_with_link | anyone
status ENUM: starting | active | ending | ended
area_precision ENUM: none | city | neighborhood | place
area_id nullable
place_id nullable
created_at
started_at
ended_at
```

### 33. Room participants — `room_participants`

```text
id
room_id
human_id nullable
guest_session_id nullable
role ENUM: initiator | moderator | participant | viewer
media_state ENUM: watching | audio | camera
status ENUM: invited | waiting | active | left | removed
audience_consent_level
joined_at
left_at
```

Exactly one of `human_id` or `guest_session_id` must be present.

### 34. Guest sessions — `guest_sessions`

```text
id
room_id
display_name
session_secret_hash
device_fingerprint_hash nullable
created_at
expires_at
removed_at nullable
```

Guest session expires with room plus a short grace period. Guest has no persistent global social identity.

### 35. Room invites / links — `room_invites`

```text
id
room_id
token_hash
created_by_human_id
join_policy_override nullable
expires_at
revoked_at
```

### 36. Live discoverability

Do not create a second "livestream" table. A Live is an active Room whose visibility makes it discoverable. Materialized/indexed `live_room_state` may exist for performance.

### 37. Areas — `areas`

```text
id
type ENUM: neighborhood | city | region | country
name
parent_area_id nullable
geometry
centroid
```

World is implicit and does not require a single geographic row.

### 38. Places — `places`

```text
id
provider_reference nullable
name
area_id
lat
lng
category nullable
visibility
```

### 39. Location sharing — `location_shares`

```text
id
human_id
audience_type ENUM: friend | group | temporary_context
audience_id
precision ENUM: city | approximate | precise
expires_at
created_at
revoked_at
```

No permanent exact-location sharing in V1.

### 40. Notifications — `notifications`

```text
id
recipient_human_id
type
actor_human_id nullable
object_type
object_id
payload
priority ENUM: critical_social | high | normal | low
read_at nullable
created_at
push_sent_at nullable
```

### 41. Reports — `reports`

```text
id
reporter_human_id nullable
reporter_guest_session_id nullable
target_type
target_id
reason
details nullable
status
created_at
resolved_at
```

---

## PART IV — AUTHENTICATION AND MEMBERSHIP

### 42. User states

Four distinct states:

- Visitor — No Earth account. Can browse public content.
- Guest — Temporary participant in one room.
- Claiming Human — In signup/Human Pass process.
- Human — Persistent verified Earth member.

Never blur these states in authorization.

### 43. Public visitor permissions

Visitor may: open public web/mobile app, browse World public content, view public profiles, view eligible World Lives, preview a group invitation, open an eligible Guest room link, start Claim flow.

Visitor may not: react, reply, post, message, friend/follow, join groups persistently, appear on map, create Live, create persistent identity.

### 44. Launch membership gate

When Visitor taps "Claim your place" show: "Earth starts with your people."

Primary options:
- Join a group — Input/open an invite.
- Start a group — Creates the first social context.

Do not offer "Continue without a group" during launch mode.

This behavior must be controlled by a server feature flag: `GROUP_ANCHORED_CLAIM_REQUIRED=true`. This allows removal later without app rewrite.

### 45. Start-group claim flow

1. Visitor taps Start a group.
2. Ask for temporary group label: "Optional: Give this group a name". Skip allowed.
3. Show: "Claim your place to start the group."
4. Authentication credential. Preferred V1: phone OTP or email OTP.
5. Public identity: display name required, profile photo optional, handle auto-suggested, editable.
6. Human Pass: "Prove you're human". Explain minimally: "Earth is one person, one place. Verification is private and is not shown on your profile."
7. Verification succeeds.
8. Create Human + group + owner membership + conversation in one transaction.
9. Show: "You're on Earth."
10. Show group screen with prominent: "Bring them here" — Share link.

### 46. Join-group claim flow

1. Visitor opens group link.
2. Preview: "Weekend Crew — Maya, Xavier + 5 others", subject to privacy. CTA: "Join them"
3. Authentication credential.
4. Public identity.
5. Human Pass.
6. Create Human.
7. Atomically add to group/conversation.
8. Open chat immediately. No generic Home screen interruption.

### 47. Existing Human opens group link

If already authenticated: preview group, Join, membership inserted, conversation opens. If already a member: open conversation.

### 48. Duplicate Human detection

If provider or system determines likely existing Human, show: "Looks like you're already on Earth."

Actions:
- Recover my place — Start account recovery.
- This isn't me — Create review case.
- I need help — Support/review.
- Safety issue — Dedicated identity-safety flow.

Never create a second active Human automatically.

### 49. "You're on Earth" identity moment

Minimal. White background. Centered text: "You're on Earth." Below: display name / face. Optional very restrained globe/point motion. Primary CTA: "Enter Weekend Crew". No confetti. No streak. No badge wall.

---

## PART V — APP SHELL AND GLOBAL UX

### 50. Canonical navigation

Bottom navigation: Home · Chats · Live · Earth · You. Five icons. The Live icon is central. It must not look like an Instagram create button. It represents a destination/state, not generic creation.

### 51. Universal social-radius control

Home, Live, and Earth share: Friends · Neighborhood · City · World. Text labels. No large colored pills. Selected state: darker text, subtle underline or indicator. Changing scope changes content while preserving the overall page composition.

Store last selected scope per Human. Default after membership: Friends. Default Visitor: World.

### 52. Radius semantics

- Friends — Friends + relevant group social activity.
- Neighborhood — Current Nearby/Home Neighborhood context.
- City — Current selected City.
- World — Personalized/public global feed.

The radius is a browsing context. It is not the same as an author's audience permission.

---

## PART VI — SCREEN-BY-SCREEN SPECIFICATION

### SCREEN 01 — PUBLIC WORLD

Purpose: Make Earth useful and understandable before membership. Header `earth`. Scope shows World selected. Visitors may see disabled/preview Friends/Neighborhood/City states or available public versions.

Feed: Real public World posts/Lives. No fake production Humans. Early launch content must come from a real seeded cohort.

Visitor interaction: Scroll. Open posts. Open profiles. Watch eligible public Lives. When trying to react/reply/follow, show bottom sheet: "Claim your place to join the conversation." Actions: "Claim your place", "Not now".

Empty state: Production should never intentionally launch World empty. Development uses explicitly marked seed fixtures.

### SCREEN 02 — HOME / FRIENDS

Header `earth`, Radius. Presence row: render only when there is meaningful state. Examples: "Xavier + Maya live", "Weekend Crew · 3 active", "Sarah nearby". Do not show empty placeholders.

Feed ranking: see ranking section.

Zero-Friends-but-member state: if Human only has group context, prioritize group activity, public posts from actual friends if any, relevant Humans from groups only where appropriate. Contextual prompt: "Add people you actually know" — not an onboarding takeover.

### SCREEN 03 — HOME / NEIGHBORHOOD

Header, Radius. Context subtitle: "North Beach" or current approximate area. Content: local posts, public Lives, local events/place objects when available, friends locally relevant. Privacy: never indicate someone's exact location from feed ranking unless explicitly shared.

### SCREEN 04 — HOME / CITY

Subtitle: current City. Simple city switch affordance. V1 only needs current city and home city. Architecture supports My Cities later.

### SCREEN 05 — HOME / WORLD

Broad personalized feed. V1 ranking: follows, recency, engagement quality, public Live, explicit topic tags/interactions, geographic affinity, diversity injection. No heavy ML required initially.

### SCREEN 06 — POST COMPOSER

Entry: compose control in Home; profile. Canonical fields: text, image, video, optional place, audience. Audience button visibly shown near compose action. Allowed audiences: Friends, Neighborhood, City, World. Default audience: current Home radius if posting from Home. If user usually posts Friends and is about to post World, make World state visually explicit. Do not use frightening modal every time. Use stronger confirmation only when moving materially outward from previous/current context.

Post button `Post`. Validation: at least one of text or media. Location: place tag is explicit. Do not silently publish exact GPS coordinates.

### SCREEN 07 — POST DETAIL

Show: author, Human indicator where appropriate, time, audience/context, text/media, place, reactions, replies. Replies inherit maximum audience. No reply can broaden original audience.

### SCREEN 08 — CHATS LIST

Header: "Chats". Primary new-chat icon. Rows show: avatar(s), conversation/group name, last meaningful message/activity, unread state, contextual state when valuable. Examples: "College — Maya + 2 live", "Family — Dad: photo", "Saturday — 4 nearby". Do not create tabs for Groups / DMs / Communities. Search at top.

### SCREEN 09 — NEW CHAT

Search Humans already on Earth. Recent people. Select one: DM. Select 2+: group conversation. After selection: open composer. Do not force group name.

### SCREEN 10 — GROUP CHAT

Header: faces + group name or generated member names. Optional contextual line: "3 live · Join". Message area: clean, no sidebar. Composer minimal: `+ Message… microphone camera`. Plus sheet: Photo/video, File, Poll, Place, Here, later Activity/Plan shortcuts. Do not permanently show twelve icons.

Camera button: if no active room, start group video; if active group room, join room.

### SCREEN 11 — DM CHAT

Same messenger quality. Video button starts Direct Room. Live expansion to Friends is allowed later in room.

### SCREEN 12 — GROUP INFO

Reached by tapping header. Show: name, avatar, members, media, search messages, current plan if any, location sharing state, mute/notifications, leave group. Owner/moderator controls: remove member, manage invite links, promote moderator. Keep utilitarian and quiet.

### SCREEN 13 — LIVE HOME

Same radius selector. Friends Live rank: 1. closest friends 2. active group rooms 3. friends-of-friends in rooms containing friends 4. socially adjacent Lives. Neighborhood: public eligible Lives in approximate local context. City: public City Lives. World: personalized public Lives.

Cards show participant-aware naming. No TikTok-style immediate autoplay with overwhelming chrome. Start with a clean Live discovery list/grid/feed. Full-screen swipe mode later if evidence supports it.

### SCREEN 14 — ACTIVE ROOM

The most important V1 screen. Video faces dominate. Chrome minimal. Top: current room context ("Weekend Crew" or "Xavier + Kavon"). Small audience indicator: "Friends".

Participant layout: 1 person full screen; 2 balanced split; 3–4 grid; 5+ adaptive grid / active speaker emphasis.

Bottom controls: microphone, camera, flip camera, participants, `Open up` / audience, more, leave. Do not use red end-call button as giant visual center unless necessary.

Joining as viewer: viewer sees "Join them". Selecting: "Join audio" / "Join on camera" if eligible.

Comments/chat: for group context, existing group messages remain accessible through a lightweight drawer. Do not create a separate public-Live chat for group-only rooms. For World rooms, a room chat can exist later; V1 may use comments/reactions only if needed.

### SCREEN 15 — OPEN UP SHEET

Shows current visibility. Options depend on context: Just us / Group, Friends, Neighborhood, City, World. Under visibility: "Who can join" — Invite only, Group, Friends, Request, Anyone eligible. Clear explanatory microcopy. When expanding outward and multiple camera participants exist, every affected Human must have audience consent.

### SCREEN 16 — PARTICIPANT CONSENT

When Human attempts camera participation in a wider Live: "Xavier's room is visible to World. If you join on camera, people on Earth may see that you're here." Buttons: "Join on camera", "Join audio only", "Just watch". No hidden audience inheritance.

### SCREEN 17 — GUEST ROOM WEB

Critical acquisition surface. URL opens directly to room preview. Show: current participant faces/names, room context, who shared/invited where available, current join policy. CTA: "Join as Guest". Then: "Your name" single text field, camera preview optional before entry, "Join". No signup wall. If app installed: allow "Open in Earth" but do not force it. Target: link tap to conversation in <15 seconds under healthy network conditions.

### SCREEN 18 — GUEST IN ROOM

Guest appears normally with subtle "Guest" next to name in participant info. Guest can: audio, camera, leave, view allowed room state. Guest cannot: expand room visibility, invite unrelated public network, become moderator, independently DM Humans after room. Host can remove Guest.

### SCREEN 19 — GUEST POST-ROOM

Do not automatically throw giant signup modal. First experience: small optional screen: "Good hanging out. Claim your place if you want to stay connected on Earth." Buttons: "Claim my place", "Done". After repeat Guest sessions, increase relevance: "You've joined 3 Earth rooms with 11 people you know. Claim your place".

### SCREEN 20 — EARTH MAP

Header: scope radius. Map fills screen. White/light Earth design. Friends: friends who explicitly share compatible location, active group Lives with compatible place context, friends' public/allowed Moments. Neighborhood: public local Live clusters, places/activity, approximate social activity. City: city-wide Live/activity. World: zoomed globe/large geography with public Live clusters. V1 World map can be materially simpler than ultimate vision. Must still communicate: Humans are Live around Earth.

### SCREEN 21 — SEARCH

One universal input. Sections: People, Groups, Places, Posts. V1 search rank for people: 1. exact handle/name 2. friend 3. mutual count 4. group overlap 5. same city 6. general relevance. Show: "Xavier — 8 mutual friends · San Francisco". Do not expose inferred sensitive connections.

### SCREEN 22 — PROFILE

Hierarchy: 1. avatar 2. display name 3. handle 4. city if shared 5. mutual friends 6. actions. Actions: Add Friend / Friends, Follow / Following, Message if allowed, more. Content: Now / posts; basic Earth/place context later. Follower numbers visually secondary.

### SCREEN 23 — NOTIFICATIONS

No tabs required V1. Priority ranking. Examples: "Xavier is live — Cooking dinner", "Weekend Crew is live — Xavier, Maya + 2", "Maya accepted your friend request", "Six friends are going tonight", "Alex followed you". Likes appear lower.

### SCREEN 24 — YOU

Your own profile. Primary: profile, posts, friend/follow counts quietly, Settings. Scaffold: "Your Earth" — V1 opens basic map/history if any. Do not build sophisticated lifetime product yet.

### SCREEN 25 — SETTINGS

Account: display identity, handle, access credentials, recovery, deactivate/delete. Privacy: profile, default post audience, Live defaults, location. Notifications: messages, Live, social, engagement. Safety: blocked Humans, report history if appropriate. Human identity: Human Pass status, recovery/help.

---

## PART VII — MESSAGING BEHAVIOR

### 53. Realtime delivery

When Human sends message: 1. create client-generated UUID 2. render optimistic pending message 3. server validates conversation membership/block state 4. persist 5. publish realtime event 6. sender receives acknowledgement 7. update state to sent 8. recipients receive 9. push recipients not currently active 10. delivery/read state updates.

Retries must be idempotent by client message ID.

### 54. Message ordering

Server timestamp is canonical. Client optimistic ordering may use local timestamp until acknowledgement. Handle offline messages without duplicate sends.

### 55. Read state

Track per conversation: `last_read_message_id`. Do not store a row for every recipient/message unless needed later. Group read receipts can initially show "Seen by X" with details on message action. Avoid visual clutter.

### 56. Blocking in messaging

If A blocks B: B cannot send new messages to A; existing conversation remains locally accessible according to policy; group membership can coexist, but direct visibility/interactions should be suppressed where feasible; block does not automatically remove either Human from mutual group; safety UX must make group coexistence understandable.

---

## PART VIII — LIVE / RTC BEHAVIOR

### 57. Creating a group video

From group: tap camera. Server: 1. check membership 2. find active room for group 3. if active, join it 4. else create `room` 5. create initiator participant 6. generate LiveKit token 7. set group active-room reference 8. notify group members according to preferences. Visibility default: Group. Join policy: Group.

### 58. Going Live to Friends

Initiator taps `Open up → Friends`. Server: 1. confirm initiator/moderator rights 2. collect active camera participants 3. obtain consent status 4. participants not yet consented receive consent UI 5. visibility changes only after required active participants accept or non-consenting participants downgrade/leave camera 6. room indexed in Friends Live discovery 7. notifications generated selectively.

Eligible Friends audience is the union of friendship graphs of consenting active Human participants, filtered by: blocks, privacy, notification preference, safety restrictions. This cross-pollination is intentional.

### 59. Joining an active Friends Live

A Human may see "Xavier + Kavon are live". Tap. Default: viewer. If join policy allows: `Join them`. When joining camera: their own friends may become eligible to see the Live because they are now a visible participant. Explicit consent copy must say this.

### 60. Participant-aware naming

For each viewer, sort participants by social relevance: 1. direct friend 2. shared group 3. familiar/mutual context 4. other participant. Feed card selects the most relevant 1–3 visible Humans. Two viewers may see different naming order for the same Room. Underlying room identity stays stable.

### 61. Moderator transfer

If sole moderator leaves and verified Humans remain: automatically transfer moderator to 1. existing moderator if available 2. earliest active verified participant. Toast: "You're keeping the room open." If only Guests remain: end room after short grace period. Guests cannot own persistent room moderation.

### 62. Live end

Room ends when: moderator ends it; zero eligible Humans remain after grace period; policy/safety system terminates it. Update: room status, active-room pointers, feed indexes, participant records. V1 does not automatically create replay.

---

## PART IX — FEED IMPLEMENTATION

### 63. V1 feed generation

Do not build ML recommender infrastructure first. Use candidate generation + deterministic weighted ranking. For each request: 1. generate eligible candidates 2. filter permissions/blocks 3. compute score 4. diversity pass 5. paginate by stable cursor.

### 64. Friends candidate pool

Candidates: public/friends posts by direct friends; posts from followed Humans with meaningful social relationship; active Lives containing direct friends; active group Live objects; group activity events suitable for feed; friend events/plans later. Do not automatically flood feed with every public post from every shared-group stranger.

### 65. Friends score

```text
relationship     0.35
now/live         0.25
group_context    0.15
recency          0.15
quality          0.10
```

Tune via data. Lives can receive strong temporary `now` boosts.

### 66. Neighborhood candidate pool

Public Neighborhood posts; eligible nearby public Live; relevant City posts with local proximity; friends nearby; eventually places/events. Filter precise coordinates before rendering.

### 67. City candidate pool

City posts; public City Live; followed/friend City activity; relevant city-level public objects.

### 68. World candidate pool

World posts; public Lives; followed Humans; socially adjacent public content; explicit-interest content; geographic affinities; high-quality exploration candidates.

```text
interest          0.25
social            0.20
quality           0.20
recency           0.15
novelty           0.10
place_affinity    0.10
```

Include diversity rules so one author/topic does not dominate.

### 69. Public visitor World

Visitor has no Human graph. Use: general quality, recency, language/locale, coarse region, currently compelling Live, editorial/launch cohort signals. Do not fingerprint visitors invasively merely to personalize public browsing.

### 70. Feed pagination

Cursor pagination. Cursor must remain stable enough to avoid duplicating cards during ordinary scroll. Do not use offset pagination.

---

## PART X — AUDIENCE AND PERMISSION ENGINE

### 71. Canonical permission function

Every content fetch must conceptually pass:

```ts
canViewObject({ viewer, object, audience, relationship, groupMembership, areaContext, blockState })
```

Never rely only on hiding UI. Server/database authorization is canonical.

### 72. Audience integrity

A Friends post cannot be reshared to World. Allowed reshare audience must be equal to or narrower than source audience. Replies cannot exceed root audience. Deleted/blocked content disappears from distribution promptly.

### 73. Screenshot reality

Earth cannot guarantee that recipients will not screenshot limited content. Do not falsely claim technical prevention. Audience integrity controls Earth-native redistribution.

---

## PART XI — LOCATION

### 74. V1 location principles

Do not continuously store exact user location for social history. Request location only when needed for: current Neighborhood, current City, map, explicit share, place tagging. Convert raw location to area context. Discard unnecessary precision from normal relevance events.

### 75. Location-sharing UX

When a Human explicitly shares precise location: "Share with Weekend Crew". Duration required: 1 hour, Tonight, custom short period. No "forever" default.

### 76. Public Live location

World/City Live defaults to City or Neighborhood, not exact GPS. Human may explicitly attach a public Place ("Dolores Park"). That is different from exposing device coordinates.

---

## PART XII — HUMAN PASS AND IDENTITY SAFETY

### 77. Verification requirement

Full Human membership requires: valid auth credential; passed Human verification OR approved manual review; no unresolved duplicate conflict. No `active Human` bypass in production.

### 78. Verification privacy

Consumer copy: "Earth verifies that one real person is claiming one place. Your verification details are private." Do not put legal name, biometric result, identity document details on public profile.

### 79. Accessibility fallback

If automated verification fails: allow "Get help verifying" — create review record. Do not imply failed biometric automation means person is not Human.

### 80. Recovery

Recovery verifies enough independent signals to restore the existing Human. Recovery does not create a replacement Human by default.

---

## PART XIII — SAFETY AND MODERATION

### 81. Mandatory V1 controls

Every Human profile: Block, Report. Every post: Report, Hide, Block author. Every room: Leave, Report, moderator Remove, moderator Disable Guests, moderator Change join policy, moderator End room. Every Guest: Remove, report, block session/device from room.

### 82. Report reasons

Harassment, Threats, Hate, Sexual content, Exploitation/minor safety, Impersonation, Spam/scam, Nonconsensual imagery, Dangerous location/stalking behavior, Violence, Other. High-severity categories receive priority.

### 83. Rate limits

Server rate limiting for: auth attempts, group invite creation, room link joins, messages, posts, follows/friend requests, reports, search, Live creation. Guests receive stricter limits.

### 84. Minor handling

If Earth launches 18+ first, encode age-gating architecture but keep product scope clear. If minors are permitted, stricter requirements become launch blockers. Do not accidentally admit minors into adult defaults without policy.

---

## PART XIV — NOTIFICATIONS

### 85. Notification philosophy

Notifications should primarily mean: something socially meaningful is happening. Do not train people to disable Earth with engagement spam.

### 86. Exact V1 notification types

- Direct message — "Xavier" + message preview
- Group message — "Weekend Crew" + "Maya: message preview"
- Friend Live — "Xavier is live" + "Cooking dinner"
- Multi-person Live — "Xavier + Maya are live" + "Join them"
- Group Live — "Weekend Crew is live" + "Xavier, Maya + 2"
- Friend request — "Maya wants to be friends"
- Accepted — "You and Maya are friends"
- Follow — "Sam followed you"
- Group invitation — "Xavier brought you into Weekend Crew"

### 87. Live notification dedupe

Do not send a push every time participant roster changes. Rules: initial high-relevance Live notification; optional second notification if a very close friend joins and materially changes relevance; cooldown per room/recipient; no participant-churn spam.

---

## PART XV — AESTHETIC AND DESIGN SYSTEM

### 88. Product feeling

Earth must feel: simple, permanent, human, calm, physical, premium, alive. It must not feel: Instagram-like, TikTok-like, Discord-like, startup-dashboard-like, gamer-like, "AI app"-like, Anthropic beige, black casino.

### 89. Canonical palette

```text
background:       #FFFFFF
surface:          #FFFFFF
text-primary:     #111214
text-secondary:   #72757A
separator:        #ECEDEF
subtle-fill:      #F6F7F8
live:             #E6463E
earth-accent:     #2459D3
danger:           semantic system red
success:          semantic system green
```

Earth accent appears sparingly. Live red has much stronger semantic importance.

### 90. Typography

Native/system-quality typography first.

```text
Display       32 / semibold
Title         24 / semibold
Section       18 / semibold
Body          16 / regular
Secondary     14 / regular
Meta          12 / medium
```

No decorative type in functional UI.

### 91. Spacing

8-point baseline. Screen horizontal margin 16; feed object spacing 20–28; compact row gap 8–12. Do not over-card the interface.

### 92. Feed post visual

Text post: avatar, name, minimal metadata, generous text, subdued actions. Photo/video: same identity header, media large, no thick rounded card around whole post. Live: visually distinct primarily through live media, participant faces/names, small Live mark — not giant colored borders.

### 93. Radius control visual

Text row: Friends Neighborhood City World. No filled segmented-control background. Selected item: primary text, 1–2 px understated underline/indicator. Unselected secondary gray.

### 94. Chat visual

Prioritize speed, legibility, faces, messages. Message bubbles may exist, but avoid excessive gradients. More refined than default messaging clone.

### 95. Motion

Restrained 180–300 ms transitions. Signature motion: Live card expands into Room; map point expands into Live; Live can collapse toward map context; radius transition softly crossfades/reorders content. No ornamental springiness everywhere.

---

## PART XVI — ANALYTICS EVENT CONTRACT

### 96. Required identity properties

Every event where applicable: human_id, anonymous_visitor_id, guest_session_id, group_id, room_id, conversation_id, scope, app_version, platform, timestamp. Do not attach exact GPS to general analytics events.

### 97. Required events

Membership: public_world_viewed, claim_started, claim_group_join_selected, claim_group_start_selected, human_verification_started, human_verification_passed, human_verification_failed, human_claimed, account_recovery_started

Groups: group_created, group_invite_shared, group_invite_opened, group_joined, group_left, second_group_joined

Messaging: message_sent, message_received, message_replied, reaction_added, voice_message_sent, media_message_sent

Video / Live: room_created, room_joined, room_left, camera_enabled, audio_joined, room_visibility_changed, live_card_impression, live_card_opened, live_join_requested, participant_consent_shown, participant_consent_accepted, guest_room_opened, guest_joined, guest_room_completed

Feed: feed_opened, scope_changed, post_impression, post_opened, post_created, post_reacted, post_replied, post_hidden

Social: friend_requested, friend_accepted, follow_created, profile_viewed, search_performed

Safety: human_blocked, content_reported, room_participant_removed, guest_removed

---

## PART XVII — V1 DASHBOARD METRICS

### 98. Core acquisition

Track daily/weekly: Group Seed Rate (Humans who start/join group / claim-intent Visitors); Humans per Seed; Group Activation Rate (created groups reaching ≥3 active Humans); Group Migration Depth (joined Humans / estimated invited members); Second Group Rate (% of Humans joining/starting another group within 30 days).

### 99. Messenger metrics

Messages per active group; D1/D7/D30 group messaging retention; groups with messages on ≥3 days/week; median message delivery latency; failed message rate.

### 100. Live metrics

Active groups starting video; active groups going Live beyond private/group; Live notification CTR; viewer → audio; viewer → camera; average room participants; repeat Live participants; Guest joins; repeat Guests; Guest → Human conversion.

### 101. Feed metrics

Feed return; Friends feed usage; World usage; radius switching; relevant hide rate; meaningful reply/follow/friend actions; public Live discovery. Do not optimize only for watch time.

---

## PART XVIII — API / SERVER CONTRACTS

### 102. API style

Typed application API. Client should not directly perform sensitive multi-table invariants. Use server functions for: Human claiming, group joining, group creation, room creation/token issuance, visibility changes, friend transactions, moderation, location-sharing writes, feed generation.

### 103. Core routes/functions

```text
GET    /public/feed
GET    /public/posts/:id
GET    /public/profiles/:handle
GET    /public/rooms/:inviteToken

POST   /claim/start
POST   /claim/verify
POST   /claim/complete

POST   /groups
GET    /groups/:id
POST   /groups/:id/invites
POST   /group-invites/:token/join

GET    /conversations
GET    /conversations/:id/messages
POST   /conversations/:id/messages
PATCH  /messages/:id
DELETE /messages/:id

POST   /rooms
GET    /rooms/:id
POST   /rooms/:id/token
POST   /rooms/:id/join
POST   /rooms/:id/visibility
POST   /rooms/:id/join-policy
POST   /rooms/:id/leave
POST   /rooms/:id/end
POST   /rooms/:id/remove-participant

POST   /guest/rooms/:inviteToken/session

GET    /feed
POST   /posts
GET    /posts/:id
POST   /posts/:id/reactions
POST   /posts/:id/replies

POST   /friend-requests
POST   /friend-requests/:id/accept
DELETE /friends/:humanId
POST   /follows/:humanId
DELETE /follows/:humanId

GET    /search

GET    /notifications
POST   /notifications/:id/read

POST   /location-shares
DELETE /location-shares/:id

POST   /blocks
DELETE /blocks/:humanId
POST   /reports
```

Actual implementation may use RPC/Edge Function names rather than HTTP routes, but shared TypeScript client semantics should match.

---

## PART XIX — SECURITY

### 104. Database

RLS on exposed data; explicit grants; private schemas for sensitive Human Pass data; service-role secrets never shipped to client; signed access for private media; audit sensitive admin actions; no public enumeration of private groups; invite tokens stored hashed.

### 105. Room tokens

LiveKit token issuance only server-side. Token claims must reflect: Earth room, role, media permissions, identity/Guest, expiration. Never issue broad reusable tokens.

### 106. Secrets

Environment variables/secrets manager. Provide `.env.example`. Do not commit: Supabase service keys, LiveKit secrets, Human verification credentials, push credentials, analytics secrets.

---

## PART XX — OFFLINE / FAILURE STATES

### 107. Global offline state

App remains navigable to cached recent content. Chat messages can queue. Display "Waiting for connection", not generic errors. Live requires network and should clearly say connection unavailable.

### 108. Message failure

Failed optimistic message: visible retry indicator; tap to retry; idempotent resend.

### 109. Room connection failure

Attempt automatic reconnect. Show "Reconnecting…". If failed: "Couldn't reconnect" — actions: "Try again", "Leave". Preserve room socially if others remain.

### 110. Feed failure

Keep existing cached feed. Inline "Couldn't refresh". Do not replace whole page with giant error.

### 111. Human Pass failure

Differentiate: technical failure → "Try again"; verification inconclusive → "Get help verifying"; likely duplicate → "Recover your place". Never use generic "Verification failed."

---

## PART XXI — DEEP LINK CONTRACT

### 112. Required links

```text
https://earth.social/g/:groupInviteToken
https://earth.social/live/:roomInviteToken
https://earth.social/@handle
https://earth.social/p/:postId
```

Mobile installed: universal link opens native destination. Mobile absent: web destination loads. Guest Live must work on web. Group claim may continue web or intelligently hand off to app. Do not require app installation merely to see what was shared.

---

## PART XXII — TESTING

### 113. Unit tests

Required for: audience permission evaluation, relationship rules, block overrides, feed scoring, room state transitions, participant naming, group membership invariants, duplicate invite use, notification dedupe.

### 114. Database authorization tests

Every table/action must test: Visitor allowed/denied, Guest allowed/denied, Human owner, group member, non-member, friend, blocked Human. Treat authorization tests as launch blockers.

### 115. Integration tests

Cover: claim Human through new group; claim through existing group invite; existing Human joins group; send/receive message; start group room; expand to Friends; participant joins camera with consent; Guest joins via web link; moderator removes Guest; post Friends; ensure stranger cannot view Friends post; block removes eligibility; notification creation/dedupe.

### 116. End-to-end journeys

- E2E 1 — Start Earth: Visitor → World → Claim → Start group → verify → You're on Earth → share group.
- E2E 2 — Join group: New Visitor → group invite → verify → chat.
- E2E 3 — Group chat: A sends → B receives realtime → B replies → A sees.
- E2E 4 — Video: A starts group call → B sees active state → joins.
- E2E 5 — Friend Live: A + B active → Open to Friends → C sees Live card → C joins.
- E2E 6 — Dynamic Live title: A starts → B joins → feed updates from `A is live` to `A + B are live`.
- E2E 7 — Guest: Earth Human shares room link → browser Guest joins without account.
- E2E 8 — Guest conversion: Guest ends call → Claim CTA → group-anchored membership.
- E2E 9 — Audience integrity: Friends post cannot become visible to noneligible stranger.
- E2E 10 — Block: A blocks B → B cannot DM, discover A Live, or receive A location.
- E2E 11 — Radius: Same Home UI → Friends/Neighborhood/City/World returns correctly scoped data.
- E2E 12 — Live consent: World room → Human joining camera must acknowledge World visibility.

---

## PART XXIII — DEVELOPMENT DATA

### 117. Seed environment

Development can contain fixture Humans: Xavier, Maya, Kavon, Sarah, Ben, Chris, etc. Mark as test fixtures in non-production. Seed: friendships, two groups, posts, active-looking historical Live records, city/area examples. Production must never display fake fixture Humans.

---

## PART XXIV — FEATURE FLAGS

### 118. Required flags

```text
GROUP_ANCHORED_CLAIM_REQUIRED
PUBLIC_WORLD_ENABLED
PUBLIC_LIVE_ENABLED
NEIGHBORHOOD_ENABLED
CITY_ENABLED
WORLD_ENABLED
GUEST_ROOMS_ENABLED
FRIENDS_LIVE_EXPANSION_ENABLED
WORLD_LIVE_EXPANSION_ENABLED
LOCATION_SHARING_ENABLED
MAFIA_ACTIVITY_ENABLED
```

Features can roll out without rebuilding core architecture.

---

## PART XXV — MVP BUILD SEQUENCE

- 119. Milestone 0 — Foundation: monorepo, environments, CI, database migrations, canonical domain package, design tokens, analytics adapter, auth skeleton, error monitoring. Gate: mobile + web build cleanly from scratch.
- 120. Milestone 1 — Human + group admission: Visitor, public World shell, group invite, Start group, Claim, Human Pass adapter, Human, group membership, You're on Earth. Gate: two new people can create/join one real group from clean accounts.
- 121. Milestone 2 — Messenger: full V1 messenger baseline. Gate: test group can use it as primary thread for one week.
- 122. Milestone 3 — Private video + Guest: group RTC, DM RTC, Guest browser joining, deep links, call notifications. Gate: Guest can enter a shared room without account or installation.
- 123. Milestone 4 — Live: group Room, Friends expansion, consent, participant-aware feed object, notification, viewer → participant, moderator transfer. Gate: the canonical Xavier cooking-dinner loop works exactly.
- 124. Milestone 5 — Feed: World, Friends, posting, reactions/replies, visitor browsing, Live cards. Gate: solo Visitor has something compelling; member's Friends feed changes materially when friends are active.
- 125. Milestone 6 — Radius + basic Earth: Neighborhood, City, map, current city, basic approximate location, public Live geographic distribution. Gate: same Home/Live/Earth UI can change social radius without feeling like navigating to another app.
- 126. Milestone 7 — Safety / hardening: block, report, rate limits, moderation, privacy audit, authorization audit, notification tuning, recovery, performance, accessibility, App Store compliance work.

---

## PART XXVI — DEFINITION OF DONE FOR V1

### 127. V1 is done when all of the following are true

- Membership: a new Human can join/start a group, prove Human status, and claim one persistent identity.
- Group migration: one Human can share a clean group link to an existing group.
- Chat: the group can use Earth as a serious messenger.
- Video: the group can fluidly video chat.
- Guest: an outsider can join that video in a browser without an account.
- Live: the group can make the same conversation visible to Friends.
- Dynamic social object: if multiple Humans are Live, Earth represents the group of Humans, not just the initiator.
- Discovery: eligible friends can encounter the Live naturally and join.
- Feed: World provides meaningful public content; Friends reflects real social activity.
- Radius: Friends / Neighborhood / City / World are one coherent content-control system.
- Map: Earth visibly connects social activity to place.
- Safety: Humans can control audiences, block, report, remove participants and protect location.
- Quality: no obvious prototype-grade reliability defects in messaging/video.

---

## PART XXVII — IMPLEMENTATION RULES

### 128. Preserve product invariants

Never "simplify" implementation by breaking these:

- Guest is not Human.
- Group member is not automatically Friend.
- Friend is not Follow.
- Public identity is not Human identity.
- Live is a Room state, not separate creator object.
- Live participant naming updates as people join.
- Blocks override all discovery.
- Audience permission is server-authoritative.
- Exact location is never inferred as public permission.
- Claiming full Human membership is group-anchored while flag is enabled.
- Private group/chat content never appears in World.
- A Human cannot silently create a second Human identity.

### 129. Optimize for the core loop first

Between richer Feed and dramatically smoother group messaging/video/Live: choose the latter. Between another feature and better Live join latency: choose latency. Between richer map and Guest entering a room frictionlessly: choose Guest.

### 130. Do not improvise generic social UI

Do not introduce: Story circles, Reels tab, giant floating Create button, Discord server list, community dashboard, black default theme, gradient cards everywhere, follower count as primary profile metric, separate "Video Calls" product, separate "Livestream Studio", group management home screen, generic "For You" terminology. The product is Earth.

### 131. Code quality requirements

Typed domain objects; reusable permission functions; schema migrations; tests with every invariant; no magic strings for audiences/status; no duplicated business rules client/server; feature flags; clear provider adapters; structured logging; error handling; accessibility labels; performant lists; image caching; offline-aware messaging.

---

## PART XXVIII — WHAT TO SCAFFOLD BUT NOT FULLY BUILD

- 132. Activities: `interface RoomActivity { id: string; type: string; state: unknown }`. No Mafia UI until core Live works.
- 133. Personal Earth: schema may support Moments/place/media associations. Do not attempt decade-scale experience.
- 134. Pages: reserve identity type and table abstraction. No sophisticated organization tooling.
- 135. Monetization: reserve `CommercialObject` and sponsorship metadata where architecturally needed. No ads.
- 136. Portability: keep canonical Human ID/domain data independent of auth provider. No decentralized protocol yet.

---

## PART XXIX — IMMEDIATE POST-V1 PLAN

1. Multi-group intelligence 2. Familiarity Graph 3. Here (temporary group location) 4. Lightweight Plans 5. Mafia 6. Stronger Neighborhood/City 7. Personal Earth. Do not skip ahead.

---

## PART XXX — FINAL PRODUCT TEST

A new person should be able to hear about Earth, browse it without an account, go to an existing friend-group chat and ask: "Is anyone here on Earth?" Someone starts the Earth group. They claim their place. The group moves.

That evening Xavier cooks dinner and goes Live. Kavon gets "Xavier is live — Cooking dinner". Kavon joins. Turns on camera. The feed now says "Xavier + Kavon are live." Maya sees it because she knows Kavon. Maya joins. Xavier leaves later. The room continues.

Someone shares the room link to an iMessage friend. That person taps the link and joins as Guest without creating an account. They have a good time. Three days later they enter another Earth room. Eventually Earth tells them: "You've been here with 12 people you know. Claim your place." They start their own group.

Meanwhile the same Humans can switch Home: Friends (their people), Neighborhood (what is around them), City (San Francisco), World (their personalized view of everything). The entire thing still feels like one clean white social app.

---

## PART XXXI — THE COMMAND TO BUILD

Build from the canonical primitives outward: Humans → groups → conversation → realtime presence → Live → feed → place.

The critical V1 interaction: Friend is Live → tap → together.
The critical growth interaction: "Is anyone here on Earth?" → share group → together.
The critical identity interaction: You already have a place on Earth. Claim yours.

Your people. Your world. Live.
