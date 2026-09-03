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
- [ ] Web + mobile: Public World shell, Claim gate, Start group flow, Join group flow, You're on Earth
- [x] DB authorization matrix for all M1 tables
- [x] Gate: two clean accounts create/join one group (integration test + e2e 1, 2)

## Milestone 2 — Messenger
- [x] Migrations 02xx: messages, message_reactions, realtime publication, presence
- [x] RPC: message_send (idempotent), messages_since, conversation_mark_read, reaction_toggle, message_edit/delete, conversation_create (DM/group), conversations_list
- [x] `packages/realtime` conversation subscription + polling fallback
- [ ] Chats list, New chat, Group chat, DM chat, Group info (web + mobile), offline queue + retry
- [x] Push: notifications for messages, push_tokens, dispatcher route
- [x] Gate: e2e 3

## Milestone 3 — Private video + Guest
- [x] Migrations 03xx: rooms, room_participants, guest_sessions, room_invites, group/conversation active_room pointers
- [x] RPC: room_start/join/leave/end/set_media_state/remove_participant, room_invite_create/preview, guest_session_create, room_media_grant, room_participant_sync, rooms_sweep
- [x] Server: token route, LiveKit webhook, sweep route
- [ ] Active Room screen (web + mobile), Guest room web (preview → name → join), Guest post-room
- [ ] Deep links (`/g`, `/live`, `/@`, `/p`), AASA + assetlinks, Expo linking
- [x] Gate: e2e 4, 7, 8

## Milestone 4 — Live
- [x] RPC: room_set_visibility (consent evaluation), room_consent, room_set_join_policy, live_candidates, moderator transfer, Live notifications + cooldowns
- [x] Domain: participant naming, room titles; server `/api/live`
- [ ] Live Home, Open up sheet, Participant consent, viewer → participant (web + mobile)
- [x] Gate: e2e 5, 6, 12

## Milestone 5 — Feed
- [x] Migrations 04xx: posts, post_media, post_reactions, post_hides; storage buckets (0997, guarded for hosted storage schema)
- [x] RPC: post_create/get/react/reply/hide/delete, feed_candidates, public feed for visitors
- [x] Domain feed ranking + cursor; server `/api/feed`
- [ ] Home (all radii), Post composer, Post detail, Profile, Notifications, Search (web + mobile)
- [x] Gate: e2e 9, 11

## Milestone 6 — Radius + Earth map
- [x] Migrations 05xx: areas (PostGIS), places, location_shares, human_context; seed SF areas
- [x] RPC: area_resolve, context_set_area, location_share_create/revoke, map_objects
- [ ] MapProvider (react-native-maps / maplibre), Earth screen (web + mobile), city switch
- Gate: same UI switches radius; map shows Lives by area

## Milestone 7 — Safety / hardening
- [x] Migrations 07xx: reports, rate limits, audit log; blocks wired through every policy
- [x] RPC: block_create/remove, report_create, rate limits in all mutating RPCs, guest stricter
- [ ] Block/Report/Hide/Remove controls in every surface; Settings; recovery entry; accessibility labels
- [x] Authorization audit test (matrix over every table), privacy audit (no raw GPS persisted)
- [x] Gate: e2e 10; full test suite green

## Verification
- [ ] Adversarial review workflow over invariants (§128)
- [ ] Full CI-equivalent run locally; results recorded in review section below

## Review
(filled in at the end)
- E2E status (2026-09-03, branch claude/earth-v1-build-spec-n9wgrk, local Postgres 16 + the local stack, Chromium from `PLAYWRIGHT_BROWSERS_PATH` with fake media devices): `bash scripts/local-stack/down.sh` exit 0 · `pnpm db:test:clean` exit 0 (dropped 1 scratch database) · `pnpm --filter earth-web run build` exit 0 · `pnpm e2e` (E2E_EXTERNAL_STACK unset, so `e2e/global-setup.ts` ran `up.sh` → 63 migrations + 3 seeds onto a fresh `earth_local`, built and started apps/web on :3000 with `.local/stack.env` + `HUMAN_VERIFICATION_PROVIDER=mock APP_ENV=development`) **exit 0 four times in a row, 17/17 passed each time, no retries and nothing flaky**: runs A-D, 2.5 min each (C and D on the final tree, after `pnpm format:check` reformatted `e2e/journeys/11-radius.spec.ts`). Per spec (run A / run B): `00-smoke` health 79 ms / 47 ms, gateway 17 ms / 19 ms, wordmark 557 ms / 525 ms · `00b-harness` claim 3.0 s / 3.1 s, sign-in 679 ms / 699 ms · E2E 1 Start Earth 3.9 s / 4.2 s · E2E 2 Join group 6.8 s / 6.7 s · E2E 3 Group chat 37.7 s / 37.1 s · E2E 4 Video 14.0 s / 14.2 s · E2E 5 Friend Live 26.5 s / 26.6 s · E2E 6 Dynamic Live title 22.6 s / 22.8 s · E2E 7 Guest 8.6 s / 9.0 s (link tap → in the room 2421 ms / 2509 ms, spec §112 target 15 s) · E2E 8 Guest conversion 13.3 s / 12.3 s · E2E 9 Audience integrity 13.3 s / 13.2 s · E2E 10 Block 42.7 s / 41.9 s · E2E 11 Radius 2.1 s / 2.0 s · E2E 12 Live consent 15.4 s / 15.8 s. No regression from the run: `pnpm --filter @earth/db-tests run test` exit 0 (67 files / 4212 tests) · `pnpm typecheck` exit 0 (15/15) · `pnpm lint` exit 0 (15/15) · `pnpm format:check` exit 0 · `pnpm turbo run test --filter='!@earth/db-tests' --filter='!@earth/e2e'` exit 0 (22/22 tasks: @earth/permissions 2336, earth-web 348, earth-mobile 340, @earth/observability 287, @earth/domain 268, @earth/server 189, @earth/api 153, @earth/auth 141, @earth/realtime 108, @earth/ui 82, @earth/analytics 81, @earth/config 64) · `pnpm test:root` exit 0 (90 passed / 6 skipped = the live `stack.test.ts` suite, stack down at test time). Two harness defects fixed, no product change needed: (1) `e2e/global-setup.ts` started its web server, lost :3000 to a server left over from an earlier session (`EADDRINUSE` in `.local/logs/e2e-web.log`) and the whole run went green against that stale build — setup now refuses to start when anything already answers `/api/health` and races the server's exit against the readiness wait, so a dead server fails the run instead of handing it to a stranger; (2) `uniqueName()` in `e2e/fixtures/people.ts` built every name from one per-process `runId()` plus a counter, so two journeys' people differed by one character (`Ada mtm0cjeq55043` / `Ada mtm0cjeq5504w`, trigram similarity 0.8) and `search` (0900) answered E2E 10's post-block search with another journey's Ada — names now carry their own random tail (similarity ≤ 0.24), which is what journey independence actually requires. CI (`.github/workflows/ci.yml`, job `e2e`) now runs the journeys exactly this way — stack binaries fetched and cached, Chromium installed, one `pnpm stack:up` + `stack.test.ts` + `pnpm stack:down` smoke pass, then plain `pnpm e2e` with `E2E_EXTERNAL_STACK` unset (it used to start the stack and the web app itself and run the suite against them) — and `e2e/README.md` matches. Not claimed: the M6 gate, whose second half (“map shows Lives by area”) no journey covers — E2E 11 proves the radius half and E2E 10 walks the map's friend markers, and the map's Live pins are still unwalked.
- M0 status (2026-09-03, clean clone equivalent: node_modules removed, `pnpm install --frozen-lockfile` exit 0, local Postgres 16): `pnpm format:check` exit 0 (all files formatted) · `pnpm lint` exit 0 (15/15 tasks) · `pnpm typecheck` exit 0 (15/15) · `pnpm test` exit 0 (25/25 tasks; @earth/db-tests 88 passed, @earth/domain 268, root scripts 89 passed / 6 skipped = the live `stack.test.ts` suite because the local stack was not running) · `pnpm build` exit 0 (earth-web) · `pnpm --filter earth-mobile export:check` exit 0 (iOS bundle, 1106 modules) · `git status --porcelain | wc -l` = 24 (every entry untracked: first commit pending; .gitignore covers .local, node_modules, .next, .expo, .expo-export-check, apps/mobile/ios, apps/mobile/android) · secret scan for `sk_live` / `eyJhbGciOi` clean (only synthetic test fixtures). Note: `earth.current_human_id()` and friends land with the 01xx identity tables; M0 helpers are `earth.jwt_claims`, `is_anonymous_jwt`, `is_service_role`, `utc_now`, `raise`, `sha256_hex`, `random_token`, `request_headers`, `client_address`, `rate_limit*`. CI workflow exists but has not yet run remotely (no commits on the branch).
- Backend status (2026-09-03, local Postgres 16, branch claude/earth-v1-build-spec-n9wgrk): `pnpm exec tsx scripts/db/migrate.ts --reset` exit 0 (shim + 61 migrations + 3 seeds onto a fresh earth_local) · `pnpm format` exit 0 (136 files rewritten) then `pnpm format:check` exit 0 · `pnpm lint` exit 0 (15/15 tasks) · `pnpm typecheck` exit 0 (15/15) · `pnpm test` exit 0 (25/25 tasks: @earth/db-tests 67 files / 4212 tests, @earth/permissions 2336, @earth/domain 268, @earth/observability 287, @earth/server 189, @earth/api 153, @earth/auth 141, @earth/realtime 108, @earth/ui 82, @earth/analytics 81, @earth/config 64, earth-web 315, earth-mobile 340, root scripts 89 passed / 6 skipped = the live `stack.test.ts` suite (stack down at test time), @earth/e2e 2 passed after the fix below) · `pnpm --filter earth-web run build` exit 0 · `EXPO_NO_TELEMETRY=1 CI=1 pnpm --filter earth-mobile run export:check` exit 0 (iOS bundle 14 MB; `.expo-export-check` removed) · HTTP walk over the local stack (`scripts/local-stack/up.sh`, built web on :3000 with `.local/stack.env` + `HUMAN_VERIFICATION_PROVIDER=mock APP_ENV=development`, two real GoTrue users via email OTP through Mailpit, RPCs over PostgREST through the gateway): claim_start(start_group) → claim_set_identity → POST /api/claim/verification/start (mock, `verified`) → GET /api/claim/verification/:id → claim_complete → group_invite_create → second user claim_start(join_group, token) → identity → verification → claim_complete (same groupId/conversationId) → message_send by both (idempotent replay returns the same id) → messages_since sees both → room_start(group) → POST /api/rooms/:id/token (LiveKit HS256 JWT verified with the dev keys: identity `h:<human>`, `video.room` = room id, canPublish, TTL 7200) → second user room_join(watching) + token → GET /api/feed?scope=friends 200 with a live card ("Verify Crew is live") → GET /api/live?scope=friends 200 — every request 200; visitor: /api/feed?scope=world 200 (8 seed cards), /api/feed?scope=friends 401, /api/rooms/:id/token 401; no error lines in web/PostgREST/GoTrue logs; `down.sh` exit 0. No client↔SQL↔DTO mismatch found (0994_http_verify.sql not needed). Fixed: `pnpm test` from a shell without the stack environment failed in @earth/e2e — Playwright's standalone `next dev` had no server-tier env, so `/api/health` answered 503 until the 180 s webServer timeout, and the smoke test still expected the pre-server-tier body `{ok, service}` (`e2e/playwright.config.ts` now loads `.local/stack.env` or `.env` for the server it starts; `e2e/journeys/00-smoke.spec.ts` asserts `serverTier: 'ready'`). Open: the `avatars` / `media` / `voice` storage buckets (ARCHITECTURE §5) are declared nowhere (no migration, no `supabase/config.toml` entry), so the M5 migrations item stays unchecked.
