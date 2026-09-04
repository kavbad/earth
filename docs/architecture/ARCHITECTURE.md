# Earth V1 — Architecture Contract

This document is binding for every contributor and every implementation agent.
Read it fully before writing code. The product spec is `docs/product/EARTH_V1_SPEC.md`;
this file says *how* that spec is realized in this repository.

## 1. Runtime tiers

Earth has exactly three runtime tiers. Every rule has one home.

| Tier | Where | Responsibility |
| --- | --- | --- |
| **Database** (Supabase Postgres) | `supabase/migrations/*.sql` | Canonical data, Row Level Security, and every multi-table invariant. All sensitive mutations are `security definer` SQL functions (RPC). Authorization here is authoritative. |
| **Server** (Node, TypeScript) | `packages/server` (pure, dependency-injected) mounted as route handlers in `apps/web/app/api/**` | Anything that needs a secret or an external provider: LiveKit token minting, LiveKit webhooks, push dispatch, Human verification provider, feed ranking, first-party analytics ingest, RTC diagnostics, scheduled sweeps. |
| **Clients** | `apps/mobile` (Expo) and `apps/web` (Next.js) | Rendering, optimistic state, realtime subscriptions, calling the typed API. Never enforce security here; only reflect it. |

`supabase/functions/` intentionally contains no Deno functions in V1 (see ADR-001). The
"server functions" the spec asks for are Postgres RPC functions plus the Node server tier.

### Rule-home table (no duplicated business rules)

| Rule | Home | Tests |
| --- | --- | --- |
| Row visibility (RLS), block overrides, membership, audience gating | Database | `supabase/tests` |
| Claim transaction, group create/join, invite use counting | Database | `supabase/tests` |
| Message send (idempotent), read state, reactions | Database | `supabase/tests` |
| Room lifecycle, consent gating, moderator transfer, grace-period end | Database | `supabase/tests` |
| Notification creation and Live dedupe/cooldown | Database | `supabase/tests` |
| Rate limits | Database (`private.rate_limits`) | `supabase/tests` |
| Feed candidate eligibility | Database (`feed_candidates` RPC) | `supabase/tests` |
| Feed scoring, diversity, cursor | `packages/domain/src/feed` (run by Server) | vitest |
| Participant-aware naming | `packages/domain/src/rooms/naming.ts` (used by Server and Clients) | vitest |
| Audience narrowing check for UI (`isAudienceWithin`) | `packages/domain/src/audience.ts` | vitest |
| `canViewObject` TypeScript mirror | `packages/permissions` | vitest, sharing fixtures in `packages/permissions/fixtures/*.json` with `supabase/tests/permissions.test.ts` |
| Notification copy, room titles, relative time | `packages/ui/src/copy.ts`, `packages/domain` | vitest |
| LiveKit token claims | `packages/server/src/rooms/token.ts` | vitest |

The permissions mirror is the one deliberate double implementation: the database enforces,
the TypeScript mirror lets the Server and Clients decide affordances. Both consume the same
JSON fixture cases so they cannot drift silently.

## 2. Repository layout

```text
apps/
  mobile/              Expo 57 + expo-router. iOS + Android.
  web/                 Next.js 16 app router. Public World, links, guest rooms, full member web client, and /api server tier.
packages/
  config/              zod-validated env (server + public), feature flag keys, constants.
  domain/              enums, types, DTO zod schemas, pure logic (feed ranking, naming, audience, cursors, room activity interface).
  permissions/         canViewObject and friends (TypeScript mirror of DB policy) + fixtures.
  api/                 EarthClient: typed wrapper over supabase-js RPC/select/realtime/storage + fetch to server tier.
  auth/                session helpers, claim-flow state machine (client side), HumanVerificationProvider interface + mock + manual-review + vendor adapter.
  realtime/            conversation/room/presence channel helpers with polling fallback, LiveKit connection helpers, RTC diagnostics emitter.
  analytics/           AnalyticsProvider interface, event contract (typed union), PostHog + noop + first-party adapters.
  observability/       ErrorMonitor interface, Sentry adapters, structured logger.
  ui/                  design tokens, typography scale, spacing, canonical copy strings, icon path data, formatters.
  server/              pure server-tier handlers (token, webhooks, push, verification, feed, sweeps) with injected deps.
supabase/
  migrations/          ordered SQL migrations (see §5).
  seed/                dev fixtures (Xavier, Maya, Kavon, Sarah, Ben, Chris ...), clearly marked, never applied in production.
  tests/               vitest + pg: authorization matrix, RPC invariants, integration flows.
  functions/           README only (ADR-001).
  config.toml
e2e/                   Playwright journeys E2E 1–12 against the local stack (scripts/local-stack).
scripts/               local-stack (postgres + postgrest + gotrue + livekit + mailpit), db reset, seed, typegen.
docs/                  architecture/ (this file, ADRs), product/ (spec).
tasks/                 todo.md (plan + progress), lessons.md.
```

Package names are `@earth/<dir>` (for example `@earth/domain`). Apps are `earth-mobile`, `earth-web`.

## 3. Toolchain

- Node 22, pnpm 10, Turborepo 2. TypeScript pinned to 5.9.x (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`).
- ESLint 9 flat config + Prettier 3 at the root. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` run through turbo.
- Packages ship TypeScript source (`"exports": { ".": "./src/index.ts" }`) and are consumed via `transpilePackages` (Next) and Metro (Expo). No build step for packages except typecheck. `packages/server` is also consumed as source.
- Tests: vitest everywhere (`jest-expo` is not used). Playwright for e2e.
- Mobile: Expo SDK 57, expo-router, `@livekit/react-native` (+ `@livekit/react-native-webrtc`, `@livekit/react-native-expo-plugin`), `react-native-maps`, `expo-notifications`, `expo-camera`, `expo-image-picker`, `expo-location`, `expo-secure-store`, `expo-haptics`, `expo-linking`, `expo-image`, `expo-av` (background audio mode), `@tanstack/react-query`, `zustand`, `posthog-react-native`, `@sentry/react-native`. Requires a dev client (`expo-dev-client`), not Expo Go.
- Web: Next 16, React 19, `@supabase/ssr`, `livekit-client`, `@livekit/components-react`, `maplibre-gl`, Tailwind 4 with tokens from `@earth/ui`, `posthog-js`, `@sentry/nextjs`.
- Database: Postgres 16 with `postgis`, `pgcrypto`, `pg_trgm`, `pg_net` (hosted only, guarded), `pgtap` optional.

## 4. Identity and the four states

Supabase Auth issues credentials. A credential is **never** a Human.

- `auth.users.id` is the credential subject. `public.auth_identities(provider, provider_subject, human_id)` links credentials to Humans. Provider values: `supabase` (the auth user itself, `provider_subject = auth.uid()::text`) plus per-method rows `phone`, `email`, `apple`, `google`, `passkey` recorded for portability.
- `earth.current_human_id()` — `stable security definer`; returns the linked `humans.id` for `auth.uid()` or `null`.
- `earth.current_human()` — same but only when `humans.status = 'active'`. RLS policies for member features use this.
- `earth.current_guest_session_id(room_id)` — the caller's `guest_sessions.id` for that room, based on `auth.uid()` for an anonymous Supabase user.

| State | Credential | DB view |
| --- | --- | --- |
| Visitor | none (`anon` role) | `earth.current_human_id() is null`, `auth.uid() is null` |
| Guest | anonymous Supabase user (`is_anonymous = true` JWT claim), `guest_sessions.auth_user_id = auth.uid()` | `earth.current_human_id() is null`, guest session rows exist |
| Claiming Human | real Supabase user, `humans.status = 'pending'` | `earth.current_human_id()` not null, `earth.current_human()` null |
| Human | real Supabase user, `humans.status = 'active'` | `earth.current_human()` not null |

`earth.current_role_kind()` returns `'visitor' | 'guest' | 'claiming' | 'human' | 'service'` and is the single source used by RPCs to branch on state.

Pending Humans are invisible everywhere (no public identity reads, no search, no membership).

## 5. Database conventions

- Schemas: `public` (exposed tables + RPC), `earth` (internal helpers, revoked from `anon`/`authenticated`), `private` (Human Pass `metadata_private`, rate limits, audit, push tokens' raw values are fine in public with RLS).
- Every table: `enable row level security`; explicit `grant` statements; default `revoke all on all tables in schema public from anon, authenticated` then grant per table. Never rely on default privileges.
- Enums are Postgres enum types named exactly after the spec (`human_status`, `human_pass_status`, `relationship_type`, `group_kind`, `group_member_role`, `group_member_status`, `conversation_type`, `message_type`, `post_type`, `audience`, `reply_policy`, `reshare_policy`, `room_context_type`, `room_visibility`, `room_join_policy`, `room_status`, `area_precision`, `participant_role`, `media_state`, `participant_status`, `area_type`, `location_audience_type`, `location_precision`, `notification_priority`, `report_reason`, `report_status`, `media_provenance`, `profile_visibility`). `packages/domain/src/enums.ts` mirrors them as `as const` arrays + zod enums; DB tests assert the two lists are identical.
- IDs are `uuid default gen_random_uuid()`. Timestamps are `timestamptz`.
- Tokens (`group_invites.token_hash`, `room_invites.token_hash`, `guest_sessions.session_secret_hash`) are `sha256` hex of a random 32-byte base64url token; the plaintext is returned exactly once by the creating RPC.
- RPC naming: `public.<noun>_<verb>` (for example `group_create`, `group_invite_join`, `message_send`, `room_start`, `room_set_visibility`, `feed_candidates`, `guest_session_create`). All RPCs are `security definer`, `set search_path = public, earth, private, pg_temp`, validate the caller with `earth.current_role_kind()`, apply rate limits with `earth.rate_limit(action, key, limit, window)`, and return `jsonb` shaped exactly like the DTO in `packages/domain/src/dto/*.ts`. Errors are raised with `raise exception using errcode = 'P0001', message = '<machine_code>'` where `<machine_code>` is a stable snake_case code listed in `packages/domain/src/errors.ts` (for example `not_a_member`, `blocked`, `rate_limited`, `consent_required`, `duplicate_human`).
- Migration files: `supabase/migrations/<NNNN>_<name>.sql`. Numbering ranges: `0001–0099` extensions/schemas/helpers/enums; `0100–0199` identity + social; `0200–0299` groups + conversations + messages; `0300–0399` rooms/guests/live; `0400–0499` posts/feed; `0500–0599` areas/places/location/map; `0600–0699` notifications/push/presence; `0700–0799` safety/reports/rate limits/audit; `0800–0899` analytics/metrics/flags; `0900–0999` search/views/indexes. A later migration may alter earlier tables. Never edit a migration that another agent owns; add a new one.
- Realtime: `messages`, `room_participants`, `rooms`, `notifications`, `conversation_members` are added to the `supabase_realtime` publication. Clients subscribe with `postgres_changes` filters; RLS governs delivery.
- Storage buckets: `avatars` (public read, owner write), `media` (private, signed URLs), `voice` (private).

## 6. Server tier (`packages/server` + `apps/web/app/api`)

Pure functions with injected dependencies so they run in Next route handlers today and could move to Edge Functions or a standalone service later:

```ts
export interface ServerDeps {
  supabaseAdmin: SupabaseClient          // service role, never shipped to clients
  supabaseForUser(accessToken: string): SupabaseClient // runs RPC as the caller
  livekit: { apiKey: string; apiSecret: string; url: string }
  verification: HumanVerificationProvider
  push: PushSender
  analytics: AnalyticsSink
  logger: Logger
  now(): Date
}
```

Routes (all under `/api`, JSON, `Authorization: Bearer <supabase access token>` when applicable):

| Route | Purpose |
| --- | --- |
| `POST /api/rooms/:id/token` | Calls RPC `room_media_grant(room_id)` as the caller (Human or Guest) then mints a LiveKit token with claims derived only from the grant. |
| `POST /api/livekit/webhook` | Verifies LiveKit signature; reconciles `room_participants` via service RPC `room_participant_sync`. |
| `POST /api/claim/verification/start`, `GET /api/claim/verification/:sessionId` | Human verification provider adapter; records results via service RPC `human_pass_record_result`. |
| `POST /api/claim/verification/webhook` | Provider callback (vendor adapter). |
| `GET /api/feed?scope=&cursor=&area=` | Calls `feed_candidates` as the caller, ranks with `@earth/domain/feed`, returns `FeedPage` DTO. Visitors allowed for `scope=world`. |
| `GET /api/live?scope=&area=` | Live discovery: RPC `live_candidates` + naming. |
| `POST /api/internal/push/dispatch` | Cron-protected (`INTERNAL_CRON_SECRET`): sends unsent notifications through Expo push, marks `push_sent_at`. |
| `POST /api/internal/rooms/sweep` | Cron: `rooms_sweep()` (grace-period ends, guest expiry, location share expiry). |
| `POST /api/internal/metrics/daily` | Cron: `metrics_compute_daily(date)`. |
| `POST /api/analytics/ingest` | First-party event sink (subset of contract events), rate limited. |
| `POST /api/diagnostics/rtc` | RTC diagnostics sink. |
| `GET /api/media/:bucket/:key*` | Signed access for private media (spec §104), the URL `earth.media_url()` puts in every `PostMediaDto`: authorizes the caller with RPC `media_access_grant(bucket, storage_key)` **as the caller**, then `302`s to a short-lived signed URL minted with the service-role Storage client. Visitors allowed (world posts); anyone outside the audience gets `403 forbidden` and nothing is signed. |

## 7. Typed application API (`packages/api`)

```ts
const earth = createEarthClient({ supabase, serverBaseUrl, fetch })
earth.flags.get()
earth.claim.start(...) / setIdentity(...) / startVerification() / pollVerification() / complete()
earth.groups.create / get / invites.create / invites.preview(token) / invites.join(token) / leave / members.remove / members.promote
earth.conversations.list / get / messages.list(cursor) / messages.send(clientId, ...) / markRead / reactions.toggle
earth.rooms.start / get / join / setMediaState / consent / setVisibility / setJoinPolicy / leave / end / removeParticipant / invites.create / invites.preview(token) / token(roomId)
earth.guest.createSession(inviteToken, displayName)
earth.feed.page(scope, cursor) / earth.live.list(scope)
earth.posts.create / get / react / reply / hide / delete
earth.social.friendRequest / acceptFriend / removeFriend / follow / unfollow / profile(handle)
earth.search.query(q)
earth.notifications.list / markRead / registerPushToken
earth.location.share / revoke / setContext(areaIds)
earth.map.objects(scope, bbox)
earth.safety.block / unblock / report
earth.presence.ping(conversationId?)
```

Every method validates its result with the DTO zod schema from `@earth/domain`. Clients never call `supabase.rpc` directly outside this package.

## 8. Realtime (`packages/realtime`)

- `subscribeConversation(conversationId, handlers)`: Supabase `postgres_changes` on `messages` + `message_reactions`; if the channel fails to join within 5 s or errors, falls back to polling `messages_since(conversation_id, after_id)` every 2 s and emits an `rtc_diagnostic` of kind `realtime_fallback`. The fallback is a product feature (offline/degraded), not a hack.
- `subscribeRoom(roomId, handlers)`: `postgres_changes` on `room_participants` and `rooms` filtered by room id, same fallback with `room_state(room_id)`.
- `presence`: Supabase Realtime presence on `conversation:<id>` for typing/active state; `presence_ping` RPC every 30 s while foregrounded.
- LiveKit: `connectRoom({ token, url })` wrappers with reconnect states `connecting | connected | reconnecting | failed` and diagnostics on every transition.

## 9. Feed and Live discovery

1. RPC `feed_candidates(scope, area_id, snapshot_at, limit)` returns only objects the caller may view (audience, blocks, membership). It returns raw features: author relationship flags, group overlap, created_at, reaction/reply counts, is_live, participant relationship flags.
2. `@earth/domain/feed.rankFeed(candidates, ctx)` computes scores with the spec weights (`FRIENDS_WEIGHTS`, `WORLD_WEIGHTS`), applies diversity rules (max 2 consecutive by same author, at most 1 Live card per 4 posts after the first page), and orders deterministically by `(score desc, id asc)`.
3. Cursor: base64url JSON `{ v: 1, snapshotAt, lastScore, lastId, scope, areaId }` (implemented in `packages/domain/src/feed/cursor.ts`; the server tier must use it, never re-implement). Later pages exclude Lives (they only appear on page 1) and use keyset `(score, id)`. Offset pagination is forbidden.
4. Live cards use `orderParticipantsForViewer(participants, viewerRelations)` → `roomTitle(...)` producing `Xavier is live`, `Xavier + Kavon are live`, `Weekend Crew is live`.
5. The SCREEN 02 presence row is not ranked and carries no candidates: RPC `feed_presence()` returns the viewer's friends-live rooms, active groups and nearby friends, `packages/server/src/feed/presence.ts` labels them through `packages/domain/src/feed/presence.ts` (`Xavier + Maya live`, `Weekend Crew · 3 active`, `Sarah nearby`), and one `PresenceCardDto` is prepended to page 1 — only when there is meaningful state, never as an empty placeholder.

## 10. Rooms, consent, and tokens

- `room_start(context_type, context_id)` returns the existing active room for the context or creates one (visibility `group` / join policy `group` for groups; `invited` / `invited_only` for direct; `friends` / `friends` for standalone).
- `room_join(room_id, media_state, consent_level)`: consent level must be ≥ current room visibility when media_state is `audio` or `camera`; otherwise error `consent_required`. Viewers (`watching`) need no consent.
- `room_set_visibility(room_id, visibility, join_policy)` by initiator/moderator: if every active audio/camera Human participant has `audience_consent_level >= visibility`, apply immediately; else set `rooms.pending_visibility` and return the list of participants whose consent is pending. `room_consent(room_id, level)` and `room_set_media_state(room_id, 'watching')` re-evaluate and apply when satisfied. Widening is only ever applied by this evaluation.
- `room_leave` performs moderator transfer (existing moderator → earliest active verified Human). A room with no active Humans is ended by `rooms_sweep()` after `ROOM_GRACE_SECONDS` (default 120). `room_end` by moderator ends immediately.
- `room_media_grant(room_id)` returns `MediaGrantDto` (camelCase keys: `livekitRoom` = room id, `identity` = 'h:<human_id>' | 'g:<guest_session_id>', `name`, `role`, `canPublish`, `canSubscribe`, `canPublishData`, `ttlSeconds`). The token route never adds permissions beyond the grant. Token TTL 2 hours, one token per join.
- Ordering of visibility: `invited < group < friends < extended < neighborhood < city < world`. Join policy is independent but the UI only offers sensible pairs.

## 11. Notifications and push

- Notification rows are created by SQL (`earth.notify(...)`) inside the RPC that caused them. `push_sent_at` marks delivery. Push tokens live in `push_tokens(human_id, token, platform)`.
- Live dedupe: `notification_cooldowns(recipient_human_id, room_id, last_sent_at, notified_participant_ids)`; a room may notify a recipient at most once per 30 minutes, plus one extra time if a direct friend not yet mentioned joins on camera.
- The push dispatcher skips recipients whose `human_presence.last_active_at` is within 30 s and whose `active_conversation_id` matches the notification's conversation.

## 12. Feature flags

`feature_flags(key, enabled, payload, updated_at)` readable by everyone. Keys are exactly the spec list. `earth.flag(key)` in SQL; `@earth/config` exports `FEATURE_FLAG_KEYS`. Flags are seeded in migration `0800_flags.sql` with launch defaults (`GROUP_ANCHORED_CLAIM_REQUIRED=true`, `PUBLIC_WORLD_ENABLED=true`, `PUBLIC_LIVE_ENABLED=true`, `NEIGHBORHOOD_ENABLED=true`, `CITY_ENABLED=true`, `WORLD_ENABLED=true`, `GUEST_ROOMS_ENABLED=true`, `FRIENDS_LIVE_EXPANSION_ENABLED=true`, `WORLD_LIVE_EXPANSION_ENABLED=true`, `LOCATION_SHARING_ENABLED=true`, `MAFIA_ACTIVITY_ENABLED=false`).

## 13. Design system

Tokens live in `packages/ui/src/tokens.ts` and are the only source of colors, type scale, spacing, radii, motion durations. Web consumes them as CSS variables (`packages/ui/src/css.ts` generates `:root` variables); mobile consumes the TS object. Copy strings live in `packages/ui/src/copy.ts` and are used verbatim by both clients (spec microcopy is exact).

## 14. Environment

`packages/config/src/env.ts` validates:

- Public (client-safe, prefixed `EXPO_PUBLIC_` / `NEXT_PUBLIC_`): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `API_BASE_URL`, `LIVEKIT_URL`, `POSTHOG_KEY`, `POSTHOG_HOST`, `SENTRY_DSN`, `MAP_STYLE_URL`, `APP_ENV` (`development|preview|production`), `WEB_ORIGIN` (`https://earth.social`).
- Server: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_URL`, `HUMAN_VERIFICATION_PROVIDER` (`mock|manual_review|vendor`), `HUMAN_VERIFICATION_VENDOR_URL`, `HUMAN_VERIFICATION_VENDOR_KEY`, `HUMAN_VERIFICATION_WEBHOOK_SECRET`, `EXPO_ACCESS_TOKEN`, `INTERNAL_CRON_SECRET`, `POSTHOG_SERVER_KEY`, `SENTRY_DSN`, `ROOM_GRACE_SECONDS`.
- `HUMAN_VERIFICATION_PROVIDER=mock` is rejected when `APP_ENV=production`.

`.env.example` documents every variable. Secrets are never committed.

## 15. Local stack and tests

- `scripts/local-stack/up.sh` downloads pinned binaries into `.local/bin` (PostgREST 13.0.4, GoTrue 2.185.0, LiveKit 1.9.1, Mailpit) and runs: Postgres (system service on 5432, database `earth_local`), PostgREST on 3001, GoTrue on 9999 (anonymous sign-ins enabled, email OTP through Mailpit SMTP on 1025 / API 8025), LiveKit on 7880 in dev mode, and `apps/web` on 3000. Supabase Storage is served by the gateway itself (`scripts/local-stack/storage.mjs`) onto `.local/storage`, authorized by the `storage.objects` policies of migration 0997 — the `storage` schema those policies need comes from the Supabase shim. Supabase Realtime is not part of the local stack; the polling fallback in `@earth/realtime` covers local and degraded environments.
- `pnpm db:reset` creates the database from migrations and applies `supabase/seed` when `APP_ENV != production`.
- `supabase/tests` use vitest + `pg`: each test file creates a scratch database from a template built once per run, applies migrations, installs an `auth` schema shim (`auth.users`, `auth.uid()`, `auth.jwt()`, `auth.role()`), and impersonates roles with `set local role` + `request.jwt.claims`. The authorization matrix (`Visitor / Guest / Human owner / group member / non-member / friend / blocked`) is a table-driven test covering every exposed table.
- Component tests: `apps/web` renders with `react-dom/server` and asserts on the HTML; `apps/mobile` mounts screens with react-test-renderer through `apps/mobile/test/render.tsx` and asserts on the native tree (host type, `accessibilityLabel` / `accessibilityRole` / `accessibilityState`, copy). React Native ships Flow source and a native runtime, so `apps/mobile/vitest.config.mts` aliases `react-native` and the Expo/native modules to the host-component doubles in `apps/mobile/test/native`; Metro always bundles the real ones.
- `e2e/` Playwright uses Chromium fake media devices and Mailpit to read OTP codes. Journeys are named `e2e/journeys/01-start-earth.spec.ts` … `12-live-consent.spec.ts`.
- The Playwright journeys walk `apps/web` only (`e2e/playwright.config.ts` sets one `Desktop Chrome` project against the Next.js app). No `apps/mobile` code runs in `e2e/`; the mobile client's runtime gate is `pnpm --filter earth-mobile test` plus `expo export`.
- CI (`.github/workflows/ci.yml`): lint, typecheck, unit tests, DB tests (postgis service container), web build, `expo export`, e2e with the local stack.

## 16. Working agreement for agents

- Own the files you are assigned; do not edit files owned by another concurrent agent. If you must change a shared file (`packages/domain`, root config), add rather than rewrite, and say so in your report.
- Every RPC or rule you add ships with tests in the same change. Run the narrowest test command that proves your work and include the exact output in your report.
- Use the enums, DTOs, error codes, and copy constants; never string literals for domain values.
- Do not commit. The orchestrator commits.
- Never weaken an invariant from spec §128 to make a test pass.

## 17. Deviations from this contract, and why

This section is a record, not a revision: §1–§16 above are the contract as it was written before
the build, and they stay as they were. Everything below is a place where the implementation
deliberately does something else. Each entry says what the contract asks for, what the code does,
and the reason. Nothing here weakens a spec §128 invariant.

1. **Migration numbering runs past `0999` (§5).** §5 assigns ranges `0001–0999`. The build added a
   forward-only fix series inside `0900–0999` (`0950`–`0973`, `0996`–`0999`) and then
   `1000_fix_room_json_context_title_for_seated_outsiders.sql`. Reason: a defect in an earlier
   migration is fixed by a later one, never by editing the original (§5, §16), and the runner
   applies files in lexical order — `0999` was taken, so the next fix must sort after it
   (`"0999…" < "1000…"`, `scripts/db/migrate-core.ts:144`). The rule that still holds absolutely is
   that no two files share a numeric prefix: the hosted ledger
   `supabase_migrations.schema_migrations` keys on it, so a duplicate aborts `supabase db push`
   part-way through the schema (`duplicateMigrationVersions`, `scripts/db/migrate-core.ts:132`).

2. **Feature flags and settings live in `0006_flags_settings.sql`, not `0800_flags.sql` (§12).**
   Reason: `earth.flag(key)` and `earth.setting(key)` are called by RLS policies and RPCs from the
   `0050` range onward, so `public.feature_flags` and `public.app_settings` have to exist in the
   helper range that everything else builds on. The launch defaults §12 lists are seeded there
   verbatim (`0006_flags_settings.sql:73`), together with the four `app_settings` keys the database
   reads at runtime (`environment`, `web_origin`, `public_storage_base_url`, `room_grace_seconds`).

3. **The hosted Postgres major is 17, while local and CI run 16 (§3).** `supabase/config.toml:20`
   declares `major_version = 17`. Reason: the Supabase CLI validates this value against the majors
   Supabase actually hosts — 15 and 17 — and aborts *every* command with "Invalid db.major_version"
   for 16, so `supabase db push` could not run at all. The local stack and the CI service container
   stay on Postgres 16; nothing in the schema depends on the difference.

4. **`up.sh` does not start `apps/web` by default (§15).** §15 describes the stack as including
   "`apps/web` on 3000"; the script starts it only with `--with-web` (`scripts/local-stack/up.sh:8`).
   Reason: the Playwright harness builds and starts its own production server on that port, and a
   dev server left behind would be walked in place of the build — `e2e/global-setup.ts` now refuses
   to start when anything already answers `/api/health`.

5. **The server tier grew four dependencies and one route beyond §6.** `ServerDeps`
   (`packages/server/src/deps.ts:183`) adds `supabaseAnon` (Visitor-scope reads for
   `GET /api/feed?scope=world` and the analytics sink), `env`, `cronSecret`
   (`x-earth-cron-secret`, `packages/server/src/cron.ts:11`), and the optional `authAdmin` and
   `storage` clients. The route table gained `POST /api/account/delete`
   (`packages/server/src/router.ts:106`). Reason: account deletion is a product requirement that
   needs the Supabase admin auth API, and media signing needs the service-role Storage client;
   both are optional so the rest of the tier runs without them. `GET /api/media/:bucket/:key*` was
   added to the §6 table itself when it was built.

6. **`packages/permissions` fixtures are consumed by `supabase/tests/src/authz/permissions-fixtures.test.ts`**,
   not `supabase/tests/permissions.test.ts` (§1). Reason: the DB test package keeps every suite
   under `src/<area>/`; the fixture contract is unchanged — both sides still read the same JSON.

7. **`scripts/` has no typegen (§2).** Reason: nothing consumes generated database types. DTOs are
   zod schemas in `@earth/domain` and the DB tests assert that the SQL payloads parse against them,
   which is a stronger check than a generated type that no one validates at runtime.

8. **`e2e/` holds 14 spec files, not 12 (§2).** E2E 1–12 are there as named, plus `00-smoke`
   (the app and the gateway answer) and `00b-harness` (the claim fixture itself, proven through the
   real UI). Reason: when a journey fails, these two say whether the product or the harness broke.

9. **Storage is part of the local stack, served by the gateway (§15).** `scripts/local-stack/storage.mjs`
   implements upload / signed URL / download / delete onto `.local/storage` and holds no rule of its
   own — every request runs as the role its JWT carries and the `storage.objects` policies of
   `0997_storage_buckets.sql` decide. The `storage` schema those policies need comes from
   `supabase/tests/sql/supabase_shim.sql` (block 6), which is skipped on any database that already
   has it. Reason: without this the Storage half of the product (photo/voice messages, post media,
   avatars) executed nowhere and was proven by nothing.

10. **Supabase Realtime is not in the local stack (§15).** The gateway answers `/realtime/v1/*`
    with 503 and refuses websocket upgrades, so `@earth/realtime` takes its polling fallback.
    Reason: no redistributable single-binary Realtime server exists for the sandbox; the fallback is
    a product requirement anyway (offline/degraded, §8), so exercising it locally is not a loss.

11. **The §127 done-statements are proven end to end on the web client only.** The Playwright
    project is one `Desktop Chrome` against `apps/web` (`e2e/playwright.config.ts`). The mobile
    client's runtime gate is `pnpm --filter earth-mobile test` — pure state tests plus screen tests
    that mount the real components through `apps/mobile/test/render.tsx` — and `expo export`. Reason:
    a device harness (Maestro/Detox) needs a simulator this environment does not have.
