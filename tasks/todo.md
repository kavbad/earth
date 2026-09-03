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
- Gate: two clean accounts create/join one group (integration test + e2e 1, 2)

## Milestone 2 — Messenger
- [x] Migrations 02xx: messages, message_reactions, realtime publication, presence
- [x] RPC: message_send (idempotent), messages_since, conversation_mark_read, reaction_toggle, message_edit/delete, conversation_create (DM/group), conversations_list
- [x] `packages/realtime` conversation subscription + polling fallback
- [ ] Chats list, New chat, Group chat, DM chat, Group info (web + mobile), offline queue + retry
- [x] Push: notifications for messages, push_tokens, dispatcher route
- Gate: e2e 3

## Milestone 3 — Private video + Guest
- [x] Migrations 03xx: rooms, room_participants, guest_sessions, room_invites, group/conversation active_room pointers
- [x] RPC: room_start/join/leave/end/set_media_state/remove_participant, room_invite_create/preview, guest_session_create, room_media_grant, room_participant_sync, rooms_sweep
- [x] Server: token route, LiveKit webhook, sweep route
- [ ] Active Room screen (web + mobile), Guest room web (preview → name → join), Guest post-room
- [ ] Deep links (`/g`, `/live`, `/@`, `/p`), AASA + assetlinks, Expo linking
- Gate: e2e 4, 7, 8

## Milestone 4 — Live
- [x] RPC: room_set_visibility (consent evaluation), room_consent, room_set_join_policy, live_candidates, moderator transfer, Live notifications + cooldowns
- [x] Domain: participant naming, room titles; server `/api/live`
- [ ] Live Home, Open up sheet, Participant consent, viewer → participant (web + mobile)
- Gate: e2e 5, 6, 12

## Milestone 5 — Feed
- [ ] Migrations 04xx: posts, post_media, post_reactions, post_hides; storage buckets
- [x] RPC: post_create/get/react/reply/hide/delete, feed_candidates, public feed for visitors
- [x] Domain feed ranking + cursor; server `/api/feed`
- [ ] Home (all radii), Post composer, Post detail, Profile, Notifications, Search (web + mobile)
- Gate: e2e 9, 11

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
- Gate: e2e 10; full test suite green

## Verification
- [ ] Adversarial review workflow over invariants (§128)
- [ ] Full CI-equivalent run locally; results recorded in review section below

## Review
(filled in at the end)
- M0 status (2026-09-03, clean clone equivalent: node_modules removed, `pnpm install --frozen-lockfile` exit 0, local Postgres 16): `pnpm format:check` exit 0 (all files formatted) · `pnpm lint` exit 0 (15/15 tasks) · `pnpm typecheck` exit 0 (15/15) · `pnpm test` exit 0 (25/25 tasks; @earth/db-tests 88 passed, @earth/domain 268, root scripts 89 passed / 6 skipped = the live `stack.test.ts` suite because the local stack was not running) · `pnpm build` exit 0 (earth-web) · `pnpm --filter earth-mobile export:check` exit 0 (iOS bundle, 1106 modules) · `git status --porcelain | wc -l` = 24 (every entry untracked: first commit pending; .gitignore covers .local, node_modules, .next, .expo, .expo-export-check, apps/mobile/ios, apps/mobile/android) · secret scan for `sk_live` / `eyJhbGciOi` clean (only synthetic test fixtures). Note: `earth.current_human_id()` and friends land with the 01xx identity tables; M0 helpers are `earth.jwt_claims`, `is_anonymous_jwt`, `is_service_role`, `utc_now`, `raise`, `sha256_hex`, `random_token`, `request_headers`, `client_address`, `rate_limit*`. CI workflow exists but has not yet run remotely (no commits on the branch).
- Backend status (2026-09-03, local Postgres 16, branch claude/earth-v1-build-spec-n9wgrk): `pnpm exec tsx scripts/db/migrate.ts --reset` exit 0 (shim + 61 migrations + 3 seeds onto a fresh earth_local) · `pnpm format` exit 0 (136 files rewritten) then `pnpm format:check` exit 0 · `pnpm lint` exit 0 (15/15 tasks) · `pnpm typecheck` exit 0 (15/15) · `pnpm test` exit 0 (25/25 tasks: @earth/db-tests 67 files / 4212 tests, @earth/permissions 2336, @earth/domain 268, @earth/observability 287, @earth/server 189, @earth/api 153, @earth/auth 141, @earth/realtime 108, @earth/ui 82, @earth/analytics 81, @earth/config 64, earth-web 315, earth-mobile 340, root scripts 89 passed / 6 skipped = the live `stack.test.ts` suite (stack down at test time), @earth/e2e 2 passed after the fix below) · `pnpm --filter earth-web run build` exit 0 · `EXPO_NO_TELEMETRY=1 CI=1 pnpm --filter earth-mobile run export:check` exit 0 (iOS bundle 14 MB; `.expo-export-check` removed) · HTTP walk over the local stack (`scripts/local-stack/up.sh`, built web on :3000 with `.local/stack.env` + `HUMAN_VERIFICATION_PROVIDER=mock APP_ENV=development`, two real GoTrue users via email OTP through Mailpit, RPCs over PostgREST through the gateway): claim_start(start_group) → claim_set_identity → POST /api/claim/verification/start (mock, `verified`) → GET /api/claim/verification/:id → claim_complete → group_invite_create → second user claim_start(join_group, token) → identity → verification → claim_complete (same groupId/conversationId) → message_send by both (idempotent replay returns the same id) → messages_since sees both → room_start(group) → POST /api/rooms/:id/token (LiveKit HS256 JWT verified with the dev keys: identity `h:<human>`, `video.room` = room id, canPublish, TTL 7200) → second user room_join(watching) + token → GET /api/feed?scope=friends 200 with a live card ("Verify Crew is live") → GET /api/live?scope=friends 200 — every request 200; visitor: /api/feed?scope=world 200 (8 seed cards), /api/feed?scope=friends 401, /api/rooms/:id/token 401; no error lines in web/PostgREST/GoTrue logs; `down.sh` exit 0. No client↔SQL↔DTO mismatch found (0994_http_verify.sql not needed). Fixed: `pnpm test` from a shell without the stack environment failed in @earth/e2e — Playwright's standalone `next dev` had no server-tier env, so `/api/health` answered 503 until the 180 s webServer timeout, and the smoke test still expected the pre-server-tier body `{ok, service}` (`e2e/playwright.config.ts` now loads `.local/stack.env` or `.env` for the server it starts; `e2e/journeys/00-smoke.spec.ts` asserts `serverTier: 'ready'`). Open: the `avatars` / `media` / `voice` storage buckets (ARCHITECTURE §5) are declared nowhere (no migration, no `supabase/config.toml` entry), so the M5 migrations item stays unchecked.
