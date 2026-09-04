# Earth V1 — Build Plan

Source of truth: `docs/product/EARTH_V1_SPEC.md`. Contract: `docs/architecture/ARCHITECTURE.md`.
Build order (spec §131): Humans → groups → conversation → realtime presence → Live → feed → place.

## Milestone 0 — Foundation
- [x] Monorepo: pnpm workspace, turbo, TS 5.9 strict, ESLint 9 flat, Prettier, root scripts
- [x] `packages/domain`: enums, DTO zod schemas, error codes, pure logic stubs
- [x] `packages/config`: env validation (public/server), feature flag keys, constants
- [x] `packages/ui`: tokens, typography, spacing, copy strings, formatters
- [x] `packages/analytics`: provider interface, event contract, PostHog/noop/first-party adapters
- [x] `packages/observability`: ErrorMonitor, logger, Sentry adapters
- [x] `supabase/tests` harness (scratch DB per file, auth shim, role impersonation)
- [x] Migrations 0001–0099: extensions, schemas, enums, helper functions, grants baseline
- [x] `apps/web` Next 16 shell builds; `apps/mobile` Expo 57 shell typechecks and `expo export` works
- [x] CI workflow; `.env.example`; local-stack scripts
- Gate: `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build` from clean clone

## Milestone 1 — Human + group admission
- [x] Migrations 01xx: humans, public_identities, auth_identities, human_passes (private metadata), relationships, blocks, identity_reviews
- [x] Migrations 02xx: groups, group_members, group_invites, conversations, conversation_members
- [x] RPC: claim_start, claim_set_identity, human_pass_record_result (service), claim_complete, group_create, group_invite_create/preview/join, group_leave, member remove/promote
- [x] Human verification providers (mock, manual_review, vendor adapter) + server routes
- [x] Web + mobile: Public World shell, Claim gate, Start group flow, Join group flow, You're on Earth
- [x] DB authorization matrix for all M1 tables
- [x] Gate: two clean accounts create/join one group (integration test + e2e 1, 2)

## Milestone 2 — Messenger
- [x] Migrations 02xx: messages, message_reactions, realtime publication, presence
- [x] RPC: message_send (idempotent), messages_since, conversation_mark_read, reaction_toggle, message_edit/delete, conversation_create (DM/group), conversations_list
- [x] `packages/realtime` conversation subscription + polling fallback
- [x] Chats list, New chat, Group chat, DM chat, Group info (web + mobile), offline queue + retry
- [x] Push: notifications for messages, push_tokens, dispatcher route
- [x] Gate: e2e 3

## Milestone 3 — Private video + Guest
- [x] Migrations 03xx: rooms, room_participants, guest_sessions, room_invites, group/conversation active_room pointers
- [x] RPC: room_start/join/leave/end/set_media_state/remove_participant, room_invite_create/preview, guest_session_create, room_media_grant, room_participant_sync, rooms_sweep
- [x] Server: token route, LiveKit webhook, sweep route
- [x] Active Room screen (web + mobile), Guest room web (preview → name → join), Guest post-room
- [x] Deep links (`/g`, `/live`, `/@`, `/p`), AASA + assetlinks, Expo linking — the two association files are committed with placeholders and filled from the environment at deploy time (`apps/web/lib/deeplinks/generate-well-known.ts`, docs/DEPLOYMENT.md §4)
- [x] Gate: e2e 4, 7, 8

## Milestone 4 — Live
- [x] RPC: room_set_visibility (consent evaluation), room_consent, room_set_join_policy, live_candidates, moderator transfer, Live notifications + cooldowns
- [x] Domain: participant naming, room titles; server `/api/live`
- [x] Live Home, Open up sheet, Participant consent, viewer → participant (web + mobile)
- [x] Gate: e2e 5, 6, 12

## Milestone 5 — Feed
- [x] Migrations 04xx: posts, post_media, post_reactions, post_hides; storage buckets and object policies (0997, applied everywhere: the `storage` schema comes from the Supabase shim on a plain Postgres)
- [x] RPC: post_create/get/react/reply/hide/delete, feed_candidates, public feed for visitors
- [x] Domain feed ranking + cursor; server `/api/feed`
- [x] Home (all radii), Post composer, Post detail, Profile, Notifications, Search (web + mobile)
- [x] Gate: e2e 9, 11

## Milestone 6 — Radius + Earth map
- [x] Migrations 05xx: areas (PostGIS), places, location_shares, human_context; seed SF areas
- [x] RPC: area_resolve, context_set_area, location_share_create/revoke, map_objects
- [x] MapProvider (react-native-maps / maplibre), Earth screen (web + mobile), city switch
- Gate: same UI switches radius; map shows Lives by area

## Milestone 7 — Safety / hardening
- [x] Migrations 07xx: reports, rate limits, audit log; blocks wired through every policy
- [x] RPC: block_create/remove, report_create, rate limits in all mutating RPCs, guest stricter
- [x] Block/Report/Hide/Remove controls in every surface; Settings; recovery entry; accessibility labels — one gap left open: reporting a *specific Guest* from a room (see Review, SEC-002)
- [x] Authorization audit test (matrix over every table), privacy audit (no raw GPS persisted)
- [x] Gate: e2e 10; full test suite green

## Verification
- [x] Adversarial review workflow over invariants (§128) — findings and their disposition in the Review below
- [x] Full CI-equivalent run locally; results recorded in the review section below
- Scope of the §127 done-statements: the 17 Playwright journeys prove them end to end on the **web** client only (`e2e/playwright.config.ts` has one `Desktop Chrome` project against apps/web). The mobile client's runtime gate is `pnpm --filter earth-mobile test` — pure state tests plus the `.test.tsx` files that mount the claim, radius, room, safety, conversation, Live and map screens through `apps/mobile/test/render.tsx` — and `expo export`. A mobile end-to-end harness (Maestro/Detox against `scripts/local-stack`) is not built.

## Review

Earth V1 is built and verified. This section is the final record: what exists, what proves it,
what the adversarial review (§128) found and what happened to each finding, what is known not to
be covered, and what to do next. The dated status entries from earlier in the build are kept
below it, unedited.

### What was built

- **Database (69 migrations, `supabase/migrations/`)** — the source of truth for every rule.
  Identity and the four states (Visitor / Guest / claiming Human / Human), groups and
  group-anchored admission, conversations and idempotent messaging, rooms with consent-gated
  visibility widening and moderator transfer, posts and feed candidates, PostGIS areas / places /
  location shares, notifications with Live dedupe and cooldowns, reports / blocks / rate limits /
  audit, analytics and daily metrics, search, storage buckets and object policies. Every table has
  RLS and explicit grants; every mutation is a `security definer` RPC returning the DTO shape in
  `packages/domain/src/dto`.
- **Server tier (`packages/server`, mounted at `apps/web/app/api/[...earth]`)** — LiveKit token
  minting and webhook reconciliation, Human verification (mock / manual review / vendor adapter),
  feed ranking and the SCREEN 02 presence row, Live discovery, signed media access, push dispatch,
  room sweeps, daily metrics, analytics ingest, RTC diagnostics, account deletion. Pure handlers
  with injected dependencies; `apps/web/lib/server` is the only wiring.
- **Web client (`apps/web`, Next 16)** — public World and visitor browsing, the claim flow, chats
  (list, new, group, DM, info, offline outbox), the Active Room and Guest room web, Live Home and
  Open up, Home feed at every radius, composer, post detail, profile, notifications, search, the
  Earth map, location sharing, You + Settings, and the safety controls on every surface.
- **Mobile client (`apps/mobile`, Expo 57 + expo-router)** — the same product surfaces as native
  screens, with push registration and channels, deep links (`/g`, `/live`, `/@`, `/p`),
  `react-native-maps`, LiveKit React Native, secure storage.
- **Shared packages** — `domain` (enums, DTOs, feed ranking, naming, presence, cursors),
  `permissions` (the TypeScript mirror of DB policy, sharing fixtures with the DB tests), `api`
  (the typed EarthClient), `auth`, `realtime` (subscriptions + polling fallback), `analytics`,
  `observability`, `ui`, `config`.
- **Local stack (`scripts/local-stack`)** — Postgres, PostgREST, GoTrue, Storage, LiveKit and
  Mailpit behind one Supabase-shaped gateway, with no Docker and no Supabase CLI.
- **Docs** — `docs/DEPLOYMENT.md` (new: the full production procedure and what is not automated),
  `docs/architecture/ARCHITECTURE.md` §17 (new: every deliberate deviation and its reason),
  `docs/architecture/DB_API.md`, `README.md`, `e2e/README.md`.

### Tests, by tier

Full local run, 2026-09-03, branch `claude/earth-v1-build-spec-n9wgrk`, Postgres 16 on
127.0.0.1:5432. `pnpm test` (turbo, 26 tasks) exit 0.

| Tier / workspace                                   | Files | Tests                 |
| -------------------------------------------------- | ----- | --------------------- |
| `@earth/db-tests` (authorization matrix, RPC invariants, integration flows) | 71 | 4245 |
| `@earth/permissions` (mirror + shared fixtures)     | 8     | 2336                  |
| `earth-mobile` (state + screens through `test/render.tsx`) | 61 | 379            |
| `earth-web` (state + components via `react-dom/server`) | 67 | 376               |
| `@earth/observability`                              | 6     | 287                   |
| `@earth/domain`                                     | 19    | 274                   |
| `@earth/server`                                     | 20    | 207                   |
| `@earth/api`                                        | 14    | 153                   |
| `@earth/auth`                                       | 9     | 141                   |
| `@earth/realtime`                                   | 10    | 108                   |
| `@earth/ui`                                         | 6     | 82                    |
| `@earth/analytics`                                  | 9     | 81                    |
| `@earth/config`                                     | 6     | 64                    |
| root (`pnpm test:root`: migrate runner, local-stack) | 9    | 103 passed, 7 skipped |
| `@earth/e2e` (Playwright, 14 files)                 | 14    | 17                    |

8853 tests in total (8836 unit/DB + 17 end to end), 7 skipped (the live `stack.test.ts` cases,
which need `EARTH_REQUIRE_STACK=1` and a running stack).

### Gate run (this session)

Every command from `/home/user/earth`, in order. Full logs kept per command; exit codes below.

| Gate | Result |
| ---- | ------ |
| `pnpm install --frozen-lockfile` | 0 |
| `pnpm format:check` | 0 |
| `pnpm lint` | 0 (15/15 tasks) |
| `pnpm typecheck` | 0 (15/15 tasks) |
| `pnpm test` | 0 (26/26 tasks; counts above) |
| `pnpm --filter earth-web run build` | 0 |
| `EXPO_NO_TELEMETRY=1 CI=1 pnpm --filter earth-mobile run export:check` | 0 (iOS bundle; `.expo-export-check` deleted afterwards) |
| `pnpm db:reset` | 0 (shim + 69 migrations + 3 seeds onto a fresh `earth_local`) |
| `bash scripts/local-stack/up.sh` → `pnpm e2e` → `bash scripts/local-stack/down.sh` | 0 / 0 / 0 — 17/17 journeys, no retries |

Per spec, final `pnpm e2e` (2.6 min total, 2 workers): `00-smoke` health 40 ms, gateway 16 ms,
wordmark 495 ms · `00b-harness` claim 3.0 s, sign-in 650 ms · E2E 1 Start Earth 4.0 s ·
E2E 2 Join group 6.4 s · E2E 3 Group chat 36.9 s · E2E 4 Video 13.9 s · E2E 5 Friend Live 26.2 s ·
E2E 6 Dynamic Live title 22.5 s · E2E 7 Guest 8.6 s (link tap → in the room well inside the
spec §112 15 s target) · E2E 8 Guest conversion 13.1 s · E2E 9 Audience integrity 13.2 s ·
E2E 10 Block 42.1 s · E2E 11 Radius 2.1 s · E2E 12 Live consent 15.3 s.

The first pass of this gate was **not** green, and the failure was a real one: `pnpm test` failed
`E2E 5 — Friend Live` at `e2e/journeys/05-friend-live.spec.ts:242` with the room header reading
`Crew <id>` instead of `Bo … + Ada …`. See INV128-01 below — a genuine privacy leak that migration
0999 had only half closed. It is fixed (migration 1000) and the gate is green.

One flake was observed and is recorded rather than papered over: in the `pnpm test` pass,
`E2E 6 — Dynamic Live title` failed its first attempt and passed on retry #1 — after
`Add Friend` was clicked on a profile, the button never became `Requested` within 15 s and no
error surfaced (`askToBeFriends`, `e2e/journeys/06-dynamic-title.spec.ts:76`; artifacts in
`e2e/test-results/06-dynamic-title-…-chromium/`). The final `pnpm e2e` pass had no retries. It has
not been diagnosed; it is listed under Next steps.

### Audit findings (§128 adversarial review) — disposition

**Blocking — all seven fixed.**

| # | Finding | Disposition |
| - | ------- | ----------- |
| INV128-01 | `earth.room_json` rendered a private group's name as `contextTitle` to anyone who could discover the room | **Fixed** in two steps. `0999_fix_room_json_group_context_title.sql` gated the title on being in the room; that was not enough, because both room screens join a Live as a viewer first (`apps/web/components/rooms/RoomScreen.tsx:175`), so an outsider held a seat before reading anything and `v_in_room` was true. `1000_fix_room_json_context_title_for_seated_outsiders.sql` makes the predicate membership, not presence: a seat is not membership. Pinned by two cases in `supabase/tests/src/verify/audience.test.ts` and by `e2e/journeys/05-friend-live.spec.ts:242`. |
| INV128-02 | `notify_live` pushed `group_live` titled "<private group> is live" to non-members | **Fixed** — `0970_fix_group_live_notification_membership.sql` chooses the copy per recipient; non-members fall through to `friend_live` / `multi_live` with `contextTitle: null`. Tests in `supabase/tests/src/rooms/notifications.test.ts` and `supabase/tests/src/integration/flows.test.ts`. |
| INV128-03 | A `temporary_context` location share kept reaching whoever was in the room after it was widened | **Fixed** — `0971_fix_room_widening_revokes_location_shares.sql` revokes every live room-scoped share the moment `rooms.visibility` rises. Tests in `supabase/tests/src/geo/location.test.ts`. |
| SEC-001 | The signed-media route every post media URL points at did not exist | **Fixed** — `0972_media_signed_access.sql` (`earth.media_readable_by`, `public.media_access_grant`), `packages/server/src/media/signed.ts`, route `media.signed` in `packages/server/src/router.ts:137`, tests in `packages/server/src/media/signed.test.ts` and `supabase/tests/src/integration/server-media.test.ts`. |
| DEP-01 | `supabase/config.toml` declared `major_version = 16`, which the Supabase CLI rejects | **Fixed** — now 17, with the reason in the file; pinned by `scripts/local-stack/env.test.ts:322`. |
| DEP-02 | `0002_schemas.sql` revoked on `public.earth_migrations` with no existence guard, aborting `supabase db push` | **Fixed** — the revoke is now inside a `to_regclass` guard. |
| DEP-03 | Two pairs of migrations shared a numeric prefix (`0951`, `0961`), which the hosted ledger cannot represent | **Fixed** — renamed to `0952_fix_identity_claim.sql` and `0965_fix_messaging_blocked_direct_read_state.sql`, plus `duplicateMigrationVersions` in `scripts/db/migrate-core.ts:132` so the runner fails on any future duplicate (tests in `scripts/db/migrate.test.ts:100`). |

**Major — six fixed, two partly fixed, seven open.**

| # | Finding | Disposition |
| - | ------- | ----------- |
| DOD-01 | The §127 done-statements were proven at runtime on the web client only | **Partly fixed.** `apps/mobile/test/` (render harness + native doubles) and twelve new `.test.tsx` files now mount the real mobile screens — `earth-mobile` went from state-only to 379 tests over 61 files. Still open: no device-level end-to-end harness exists, so the journeys remain web-only. Recorded in ARCHITECTURE §17.11. |
| DOD-02 | The Storage half of the messenger executed nowhere | **Partly fixed.** The `storage` schema now comes from the Supabase shim, `0997` really creates the three buckets and five policies everywhere, `scripts/local-stack/storage.mjs` serves Storage locally under those policies, and 15 tests walk it (`supabase/tests/src/storage/objects.test.ts`, `scripts/local-stack/storage.test.ts`). Still open: no Playwright journey sends a photo or a voice message, so the browser attach/record flows are covered by component tests only. |
| SCR-01 | The SCREEN 02 presence row could never render | **Fixed** — `0973_feed_presence.sql` (`feed_presence()`), `packages/domain/src/feed/presence.ts`, `packages/server/src/feed/presence.ts`, prepended by `apps/web/components/feed/HomeFeed.tsx`; contract in ARCHITECTURE §9.5. |
| SCR-02 | SCREEN 23 (notifications) had no navigation affordance on the web | **Fixed** — `apps/web/components/feed/NotificationsButton.tsx` + `hooks/useUnreadCount.ts`, with `apps/web/lib/routes.audit.test.ts` asserting every route is reachable. |
| SCR-03 | SCREEN 21 (search) had no persistent entry point on the web | **Fixed** — `apps/web/components/feed/SearchButton.tsx`, same route audit. |
| DEP-10 | The README had no end-to-end deploy instructions | **Fixed** — `docs/DEPLOYMENT.md` (this session) plus the README's Deploy section. |
| SEC-002 | Spec §81 "Every Guest: Remove, report, block session/device from room" | **Partly fixed / open.** Remove and block-from-room work for every participant including Guests on both clients (`apps/web/components/rooms/ParticipantsSheet.tsx:87,95` and the mobile twin). Reporting a *specific Guest* is still unreachable: `reports` accepts `target_type = 'guest'` (`supabase/migrations/0700_reports.sql:26`) and both `SafetyMenu` components can build that target, but no room screen mounts them — the room's report control reports the room. |
| SEC-003 | Spec §84 age-gating architecture | **Open.** There is no birthdate, age field or minor-handling policy anywhere in the schema or the clients. A launch must decide 18+ and enforce it outside this codebase, or add the gating first. |
| DEP-04 | Association files committed with placeholders; the generator is wired into nothing | **Open.** `apps/web/lib/deeplinks/generate-well-known.ts` exists and works; no build or deploy step calls it. Procedure and the four variables are in `docs/DEPLOYMENT.md` §4 and `.env.example`. |
| DEP-05 | The `production` EAS profile supplies only `EXPO_PUBLIC_APP_ENV` | **Open.** No EAS environment is linked, so a production build has no Supabase URL, anon key or LiveKit URL. `docs/DEPLOYMENT.md` §5.2 lists what to add. |
| DEP-06 | `EAS_PROJECT_ID` is the all-zero placeholder | **Open** (`apps/mobile/app.config.ts:8`). |
| DEP-07 | No Android FCM configuration | **Open.** No `android.googleServicesFile`, no `google-services.json`; Expo push on Android needs FCM v1 credentials. |
| DEP-08 | No Google Maps API key for `react-native-maps` | **Open.** The Android map renders blank without one. |
| DEP-09 | `NEXT_PUBLIC_SENTRY_DSN` is inlined but no browser Sentry client is initialised | **Open.** Only the server tier reports (`apps/web/lib/server/wiring.ts:94`). |
| DEP-11 | `config.toml` only encodes localhost settings | **Partly fixed.** `major_version` is now correct and the file says what the hosted project must match; the hosted Auth settings themselves are still dashboard-only, and nothing asserts the hosted project matches. Documented as `docs/DEPLOYMENT.md` §11.6. |

**New, found by this gate run.**

| # | Finding | Disposition |
| - | ------- | ----------- |
| DEP-12 | The Vercel cron declarations cannot drive the routes they name | **Open.** `apps/web/vercel.json` schedules `/api/internal/push/dispatch`, `/api/internal/rooms/sweep` and `/api/internal/metrics/daily`, but Vercel Cron issues `GET` with `Authorization: Bearer $CRON_SECRET` while all three routes are `POST` + `x-earth-cron-secret` (`packages/server/src/router.ts:112`, `packages/server/src/cron.ts:11`). Left as configuration, not code: `docs/DEPLOYMENT.md` §3.4 and §11.1 give the two supported ways to schedule them. Until one is in place rooms never end on their own, guest sessions and location shares never expire, and no push is delivered. |

### Known limitations

- The local stack has **no Supabase Realtime**: the gateway answers `/realtime/v1/*` with 503 and
  refuses websocket upgrades, so every local and e2e run exercises `@earth/realtime`'s polling
  fallback rather than `postgres_changes`. The production path is configured (§1.5 of
  DEPLOYMENT.md) but is not exercised by any test here.
- The local stack's **Storage** is `scripts/local-stack/storage.mjs`, not Supabase Storage. It
  holds no rule of its own — every request is authorized by the same `0997` policies — but it is
  not the same implementation, and signed-URL semantics are re-implemented rather than shared.
- The **Human verification vendor adapter is generic**: a fixed wire contract that any vendor is
  mapped onto by configuration (`packages/auth/src/verification/vendor.ts`). No real vendor has
  been integrated or tested against; a vendor whose shape differs needs a translating proxy.
- The **mobile client is verified by typecheck, unit/screen tests and a Metro export only**. No
  build ran on a device or simulator, no EAS build was produced, push was never delivered to a
  handset, and `react-native-maps` was never rendered.
- The §127 done-statements are proven end to end **on the web client only** (17 Playwright tests,
  one Chromium project against `apps/web`).
- The Milestone 6 gate is half-proven: E2E 11 walks the radius switch and E2E 10 walks the map's
  friend markers, but no journey asserts "the map shows Lives by area".
- Nothing has been deployed. Every provider account, secret and store submission in
  `docs/DEPLOYMENT.md` is untested against a real project.

### Next steps

1. Close DEP-12 (schedule the three internal routes for real) — without it Live rooms never end
   and no notification reaches a phone. It is the single highest-value item.
2. Close the mobile release gaps together, in one pass: `EAS_PROJECT_ID`, the production EAS
   environment, FCM credentials, the Google Maps key, then an actual `eas build` and a device run
   (DEP-05 – DEP-08).
3. Run `generate-well-known.ts` from the deploy pipeline and fail the build when
   `hasPlaceholders()` is true (DEP-04).
4. Decide the §84 age policy and encode it before any public launch (SEC-003).
5. Mount `SafetyMenu` for a Guest in both room screens so a Guest can be reported, not only
   removed (SEC-002 remainder).
6. Initialise a browser Sentry client, or drop `NEXT_PUBLIC_SENTRY_DSN` from the public env so it
   stops implying coverage that does not exist (DEP-09).
7. Diagnose the `E2E 6` `Add Friend → Requested` flake; if it is a product race in
   `useProfileActions`, it is a §127 "no obvious prototype-grade reliability defects" issue, not a
   test issue.
8. Extend the journeys where coverage is thin: a photo and a voice message end to end (DOD-02
   remainder), and the map's Live pins (the Milestone 6 gate).
9. Stand up a mobile end-to-end harness (Maestro or Detox against `scripts/local-stack`) so the
   §127 statements are proven on both clients (DOD-01 remainder).

### Earlier status entries (unedited)

- E2E status (2026-09-03, branch claude/earth-v1-build-spec-n9wgrk, local Postgres 16 + the local stack, Chromium from `PLAYWRIGHT_BROWSERS_PATH` with fake media devices): `bash scripts/local-stack/down.sh` exit 0 · `pnpm db:test:clean` exit 0 (dropped 1 scratch database) · `pnpm --filter earth-web run build` exit 0 · `pnpm e2e` (E2E_EXTERNAL_STACK unset, so `e2e/global-setup.ts` ran `up.sh` → 63 migrations + 3 seeds onto a fresh `earth_local`, built and started apps/web on :3000 with `.local/stack.env` + `HUMAN_VERIFICATION_PROVIDER=mock APP_ENV=development`) **exit 0 four times in a row, 17/17 passed each time, no retries and nothing flaky**: runs A-D, 2.5 min each (C and D on the final tree, after `pnpm format:check` reformatted `e2e/journeys/11-radius.spec.ts`). Per spec (run A / run B): `00-smoke` health 79 ms / 47 ms, gateway 17 ms / 19 ms, wordmark 557 ms / 525 ms · `00b-harness` claim 3.0 s / 3.1 s, sign-in 679 ms / 699 ms · E2E 1 Start Earth 3.9 s / 4.2 s · E2E 2 Join group 6.8 s / 6.7 s · E2E 3 Group chat 37.7 s / 37.1 s · E2E 4 Video 14.0 s / 14.2 s · E2E 5 Friend Live 26.5 s / 26.6 s · E2E 6 Dynamic Live title 22.6 s / 22.8 s · E2E 7 Guest 8.6 s / 9.0 s (link tap → in the room 2421 ms / 2509 ms, spec §112 target 15 s) · E2E 8 Guest conversion 13.3 s / 12.3 s · E2E 9 Audience integrity 13.3 s / 13.2 s · E2E 10 Block 42.7 s / 41.9 s · E2E 11 Radius 2.1 s / 2.0 s · E2E 12 Live consent 15.4 s / 15.8 s. No regression from the run: `pnpm --filter @earth/db-tests run test` exit 0 (67 files / 4212 tests) · `pnpm typecheck` exit 0 (15/15) · `pnpm lint` exit 0 (15/15) · `pnpm format:check` exit 0 · `pnpm turbo run test --filter='!@earth/db-tests' --filter='!@earth/e2e'` exit 0 (22/22 tasks: @earth/permissions 2336, earth-web 348, earth-mobile 340, @earth/observability 287, @earth/domain 268, @earth/server 189, @earth/api 153, @earth/auth 141, @earth/realtime 108, @earth/ui 82, @earth/analytics 81, @earth/config 64) · `pnpm test:root` exit 0 (90 passed / 6 skipped = the live `stack.test.ts` suite, stack down at test time). Two harness defects fixed, no product change needed: (1) `e2e/global-setup.ts` started its web server, lost :3000 to a server left over from an earlier session (`EADDRINUSE` in `.local/logs/e2e-web.log`) and the whole run went green against that stale build — setup now refuses to start when anything already answers `/api/health` and races the server's exit against the readiness wait, so a dead server fails the run instead of handing it to a stranger; (2) `uniqueName()` in `e2e/fixtures/people.ts` built every name from one per-process `runId()` plus a counter, so two journeys' people differed by one character (`Ada mtm0cjeq55043` / `Ada mtm0cjeq5504w`, trigram similarity 0.8) and `search` (0900) answered E2E 10's post-block search with another journey's Ada — names now carry their own random tail (similarity ≤ 0.24), which is what journey independence actually requires. CI (`.github/workflows/ci.yml`, job `e2e`) now runs the journeys exactly this way — stack binaries fetched and cached, Chromium installed, one `pnpm stack:up` + `stack.test.ts` + `pnpm stack:down` smoke pass, then plain `pnpm e2e` with `E2E_EXTERNAL_STACK` unset (it used to start the stack and the web app itself and run the suite against them) — and `e2e/README.md` matches. Not claimed: the M6 gate, whose second half (“map shows Lives by area”) no journey covers — E2E 11 proves the radius half and E2E 10 walks the map's friend markers, and the map's Live pins are still unwalked.
- M0 status (2026-09-03, clean clone equivalent: node_modules removed, `pnpm install --frozen-lockfile` exit 0, local Postgres 16): `pnpm format:check` exit 0 (all files formatted) · `pnpm lint` exit 0 (15/15 tasks) · `pnpm typecheck` exit 0 (15/15) · `pnpm test` exit 0 (25/25 tasks; @earth/db-tests 88 passed, @earth/domain 268, root scripts 89 passed / 6 skipped = the live `stack.test.ts` suite because the local stack was not running) · `pnpm build` exit 0 (earth-web) · `pnpm --filter earth-mobile export:check` exit 0 (iOS bundle, 1106 modules) · `git status --porcelain | wc -l` = 24 (every entry untracked: first commit pending; .gitignore covers .local, node_modules, .next, .expo, .expo-export-check, apps/mobile/ios, apps/mobile/android) · secret scan for `sk_live` / `eyJhbGciOi` clean (only synthetic test fixtures). Note: `earth.current_human_id()` and friends land with the 01xx identity tables; M0 helpers are `earth.jwt_claims`, `is_anonymous_jwt`, `is_service_role`, `utc_now`, `raise`, `sha256_hex`, `random_token`, `request_headers`, `client_address`, `rate_limit*`. CI workflow exists but has not yet run remotely (no commits on the branch).
- Backend status (2026-09-03, local Postgres 16, branch claude/earth-v1-build-spec-n9wgrk): `pnpm exec tsx scripts/db/migrate.ts --reset` exit 0 (shim + 61 migrations + 3 seeds onto a fresh earth_local) · `pnpm format` exit 0 (136 files rewritten) then `pnpm format:check` exit 0 · `pnpm lint` exit 0 (15/15 tasks) · `pnpm typecheck` exit 0 (15/15) · `pnpm test` exit 0 (25/25 tasks: @earth/db-tests 67 files / 4212 tests, @earth/permissions 2336, @earth/domain 268, @earth/observability 287, @earth/server 189, @earth/api 153, @earth/auth 141, @earth/realtime 108, @earth/ui 82, @earth/analytics 81, @earth/config 64, earth-web 315, earth-mobile 340, root scripts 89 passed / 6 skipped = the live `stack.test.ts` suite (stack down at test time), @earth/e2e 2 passed after the fix below) · `pnpm --filter earth-web run build` exit 0 · `EXPO_NO_TELEMETRY=1 CI=1 pnpm --filter earth-mobile run export:check` exit 0 (iOS bundle 14 MB; `.expo-export-check` removed) · HTTP walk over the local stack (`scripts/local-stack/up.sh`, built web on :3000 with `.local/stack.env` + `HUMAN_VERIFICATION_PROVIDER=mock APP_ENV=development`, two real GoTrue users via email OTP through Mailpit, RPCs over PostgREST through the gateway): claim_start(start_group) → claim_set_identity → POST /api/claim/verification/start (mock, `verified`) → GET /api/claim/verification/:id → claim_complete → group_invite_create → second user claim_start(join_group, token) → identity → verification → claim_complete (same groupId/conversationId) → message_send by both (idempotent replay returns the same id) → messages_since sees both → room_start(group) → POST /api/rooms/:id/token (LiveKit HS256 JWT verified with the dev keys: identity `h:<human>`, `video.room` = room id, canPublish, TTL 7200) → second user room_join(watching) + token → GET /api/feed?scope=friends 200 with a live card ("Verify Crew is live") → GET /api/live?scope=friends 200 — every request 200; visitor: /api/feed?scope=world 200 (8 seed cards), /api/feed?scope=friends 401, /api/rooms/:id/token 401; no error lines in web/PostgREST/GoTrue logs; `down.sh` exit 0. No client↔SQL↔DTO mismatch found (0994_http_verify.sql not needed). Fixed: `pnpm test` from a shell without the stack environment failed in @earth/e2e — Playwright's standalone `next dev` had no server-tier env, so `/api/health` answered 503 until the 180 s webServer timeout, and the smoke test still expected the pre-server-tier body `{ok, service}` (`e2e/playwright.config.ts` now loads `.local/stack.env` or `.env` for the server it starts; `e2e/journeys/00-smoke.spec.ts` asserts `serverTier: 'ready'`). Open at the time of that run: the `avatars` / `media` / `voice` storage buckets (ARCHITECTURE §5) were declared nowhere. Closed since — see the Storage status entry below.
- Storage status (2026-09-03, audit finding DOD-02, local Postgres 16 + the local stack): the Storage half of the messenger — photo/video/file messages, voice notes, post media and the claim avatar — now executes. Before: `supabase/migrations/0997_storage_buckets.sql` guarded on the `storage` schema, `psql earth_local -Atc "select count(*) from pg_namespace where nspname='storage'"` answered `0`, so neither the three buckets nor the five `storage.objects` policies were ever created, `scripts/local-stack` had no Storage service (the gateway answered `/storage/v1/*` with 501), and no test anywhere uploaded a byte. Three changes: (1) `supabase/tests/sql/supabase_shim.sql` block 6 gives a plain Postgres the `storage` schema Supabase's Storage service owns (`buckets`, `objects`, `foldername()/filename()/extension()`, RLS, grants), so 0997 applies verbatim on the local stack and in every test template — it is skipped on a managed database and on any database that already has `storage`; (2) `scripts/local-stack/storage.mjs` is a Storage service mounted on the gateway at `/storage/v1` (upload, signed URL, signed/public/authenticated download, delete) writing to `.local/storage/<bucket>/<key>`, which holds **no rule of its own**: every request opens a transaction as the role its JWT carries, exactly as PostgREST does, and the 0997 policies decide — `up.sh` empties the object directory whenever it recreates the database; (3) two tests pin it. `supabase/tests/src/storage/objects.test.ts` (6 tests) asserts the buckets and their limits, that RLS is on, that exactly the five `earth_*` policies exist with the `(storage.foldername(name))[1] = (earth.current_human_id())::text` comparison in each, and then walks the rule row by row — a Human writes only under its own human id in all three buckets, a visitor / Guest / claiming credential writes nowhere, private objects are visible to their owner alone while avatars are visible to everyone, and only the owner may move or delete. `scripts/local-stack/storage.test.ts` (9 tests) drives a real `@supabase/storage-js` client over a real socket against a freshly migrated database: a photo lands on disk with its row, a voice note sent the browser's way (multipart Blob) lands too, an upload into another member's folder is refused by row level security **and writes no byte**, a signed URL round-trips through a plain `fetch` while a forged token is refused, the service role signs (the `GET /api/media/:bucket/:key*` path of spec §104) and another member cannot, and a public avatar is readable with no credential. Live-stack walk: `pnpm stack:up` → `select count(*) from storage.buckets` = 3, `pg_policies where schemaname='storage'` = 5, `POST /storage/v1/object/media/<own human>/live-walk.jpg` with a session JWT → `{"Id":…,"Key":"media/…"}` and 15 bytes in `.local/storage`, the same POST into another Human's folder → `403 {"error":"Unauthorized","message":"new row violates row-level security policy"}`, `POST /object/sign/...` → signed URL that returns the bytes as `image/jpeg`; `EARTH_REQUIRE_STACK=1 pnpm exec vitest run scripts/local-stack/stack.test.ts` exit 0 (9 passed). Still open: no Playwright journey sends a photo or a voice message — E2E 3 covers text, replies, reactions and read receipts only — so the browser-side attach and record flows (`apps/web/components/chats/ConversationScreen.tsx:166,203`) remain covered by component tests rather than end to end, and the mobile equivalents likewise. Also note: a database kept across this change with `KEEP_DB=1` has 0997 recorded as applied from when it was a no-op; one `pnpm stack:up` (which resets by default) creates the buckets and policies.
