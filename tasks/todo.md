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
- [ ] Migrations 01xx: humans, public_identities, auth_identities, human_passes (private metadata), relationships, blocks, identity_reviews
- [ ] Migrations 02xx: groups, group_members, group_invites, conversations, conversation_members
- [ ] RPC: claim_start, claim_set_identity, human_pass_record_result (service), claim_complete, group_create, group_invite_create/preview/join, group_leave, member remove/promote
- [ ] Human verification providers (mock, manual_review, vendor adapter) + server routes
- [ ] Web + mobile: Public World shell, Claim gate, Start group flow, Join group flow, You're on Earth
- [ ] DB authorization matrix for all M1 tables
- Gate: two clean accounts create/join one group (integration test + e2e 1, 2)

## Milestone 2 — Messenger
- [ ] Migrations 02xx: messages, message_reactions, realtime publication, presence
- [ ] RPC: message_send (idempotent), messages_since, conversation_mark_read, reaction_toggle, message_edit/delete, conversation_create (DM/group), conversations_list
- [ ] `packages/realtime` conversation subscription + polling fallback
- [ ] Chats list, New chat, Group chat, DM chat, Group info (web + mobile), offline queue + retry
- [ ] Push: notifications for messages, push_tokens, dispatcher route
- Gate: e2e 3

## Milestone 3 — Private video + Guest
- [ ] Migrations 03xx: rooms, room_participants, guest_sessions, room_invites, group/conversation active_room pointers
- [ ] RPC: room_start/join/leave/end/set_media_state/remove_participant, room_invite_create/preview, guest_session_create, room_media_grant, room_participant_sync, rooms_sweep
- [ ] Server: token route, LiveKit webhook, sweep route
- [ ] Active Room screen (web + mobile), Guest room web (preview → name → join), Guest post-room
- [ ] Deep links (`/g`, `/live`, `/@`, `/p`), AASA + assetlinks, Expo linking
- Gate: e2e 4, 7, 8

## Milestone 4 — Live
- [ ] RPC: room_set_visibility (consent evaluation), room_consent, room_set_join_policy, live_candidates, moderator transfer, Live notifications + cooldowns
- [ ] Domain: participant naming, room titles; server `/api/live`
- [ ] Live Home, Open up sheet, Participant consent, viewer → participant (web + mobile)
- Gate: e2e 5, 6, 12

## Milestone 5 — Feed
- [ ] Migrations 04xx: posts, post_media, post_reactions, post_hides; storage buckets
- [ ] RPC: post_create/get/react/reply/hide/delete, feed_candidates, public feed for visitors
- [ ] Domain feed ranking + cursor; server `/api/feed`
- [ ] Home (all radii), Post composer, Post detail, Profile, Notifications, Search (web + mobile)
- Gate: e2e 9, 11

## Milestone 6 — Radius + Earth map
- [ ] Migrations 05xx: areas (PostGIS), places, location_shares, human_context; seed SF areas
- [ ] RPC: area_resolve, context_set_area, location_share_create/revoke, map_objects
- [ ] MapProvider (react-native-maps / maplibre), Earth screen (web + mobile), city switch
- Gate: same UI switches radius; map shows Lives by area

## Milestone 7 — Safety / hardening
- [ ] Migrations 07xx: reports, rate limits, audit log; blocks wired through every policy
- [ ] RPC: block_create/remove, report_create, rate limits in all mutating RPCs, guest stricter
- [ ] Block/Report/Hide/Remove controls in every surface; Settings; recovery entry; accessibility labels
- [ ] Authorization audit test (matrix over every table), privacy audit (no raw GPS persisted)
- Gate: e2e 10; full test suite green

## Verification
- [ ] Adversarial review workflow over invariants (§128)
- [ ] Full CI-equivalent run locally; results recorded in review section below

## Review
(filled in at the end)
- M0 status (2026-09-03, clean clone equivalent: node_modules removed, `pnpm install --frozen-lockfile` exit 0, local Postgres 16): `pnpm format:check` exit 0 (all files formatted) · `pnpm lint` exit 0 (15/15 tasks) · `pnpm typecheck` exit 0 (15/15) · `pnpm test` exit 0 (25/25 tasks; @earth/db-tests 88 passed, @earth/domain 268, root scripts 89 passed / 6 skipped = the live `stack.test.ts` suite because the local stack was not running) · `pnpm build` exit 0 (earth-web) · `pnpm --filter earth-mobile export:check` exit 0 (iOS bundle, 1106 modules) · `git status --porcelain | wc -l` = 24 (every entry untracked: first commit pending; .gitignore covers .local, node_modules, .next, .expo, .expo-export-check, apps/mobile/ios, apps/mobile/android) · secret scan for `sk_live` / `eyJhbGciOi` clean (only synthetic test fixtures). Note: `earth.current_human_id()` and friends land with the 01xx identity tables; M0 helpers are `earth.jwt_claims`, `is_anonymous_jwt`, `is_service_role`, `utc_now`, `raise`, `sha256_hex`, `random_token`, `request_headers`, `client_address`, `rate_limit*`. CI workflow exists but has not yet run remotely (no commits on the branch).
