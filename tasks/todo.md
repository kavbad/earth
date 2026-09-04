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
- [x] Gate: `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build` from clean clone — all five green on the final gate (2026-09-04)

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
- [x] Deep links (`/g`, `/live`, `/@`, `/p`), AASA + assetlinks, Expo linking — both association files are served from the environment at request time by `apps/web/app/.well-known/*/route.ts` (docs/DEPLOYMENT.md §4)
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
- [x] Gate: same UI switches radius (E2E 11 walks it end to end); map shows Lives by area — proven at the DB and component tier by `supabase/tests/src/map-search/map.test.ts` (`map_objects` returns each Live inside the bbox at every radius, none outside) and the marker-state tests on both clients. No journey walks a Live pin; see Known limitations.

## Milestone 7 — Safety / hardening
- [x] Migrations 07xx: reports, rate limits, audit log; blocks wired through every policy
- [x] RPC: block_create/remove, report_create, rate limits in all mutating RPCs, guest stricter
- [x] Block/Report/Hide/Remove controls in every surface, a named Guest in a room included (Review, SEC-002); Settings; recovery entry; accessibility labels
- [x] Authorization audit test (matrix over every table), privacy audit (no raw GPS persisted)
- [x] Gate: e2e 10; full test suite green

## Verification
- [x] Adversarial review workflow over invariants (§128) — findings and their disposition in the Review below
- [x] Full CI-equivalent run locally; results recorded in the review section below
- Scope of the §127 done-statements: the 17 Playwright journeys prove them end to end on the **web** client only (`e2e/playwright.config.ts` has one `Desktop Chrome` project against apps/web). The mobile client's runtime gate is `pnpm --filter earth-mobile test` — pure state tests plus the `.test.tsx` files that mount the claim, radius, room, safety, conversation, Live and map screens through `apps/mobile/test/render.tsx` — and `expo export`. A mobile end-to-end harness (Maestro/Detox against `scripts/local-stack`) is not built.

## Review

Earth V1 is built, audited, fixed in three waves and green on the final gate. This section is the
closing record: what exists per milestone, what proves it, every review finding across all three
waves and what happened to it, what is still open and why, and what is known not to be covered.
The dated status entries from earlier in the build are kept below it, unedited.

### What was built, per milestone

- **M0 Foundation** — pnpm/turbo monorepo, TS 5.9 strict, ESLint 9 flat + Prettier; `packages/`
  `domain` (enums, DTO schemas, error codes, feed ranking, naming, presence, cursors), `config`,
  `ui`, `analytics`, `observability`, `permissions` (the TypeScript mirror of DB policy), `api`
  (typed EarthClient), `auth`, `realtime`; the `supabase/tests` harness (scratch DB per file, auth
  shim, role impersonation); migrations 0001–0099; `scripts/local-stack` (Postgres, PostgREST,
  GoTrue, Storage, LiveKit, Mailpit behind one Supabase-shaped gateway, no Docker, no Supabase
  CLI); CI and deploy workflows; `.env.example`.
- **M1 Human + group admission** — migrations 01xx/02xx (humans, public/auth identities, human
  passes with private metadata, relationships, blocks, identity reviews, groups, invites,
  conversations); `claim_start` → `claim_set_identity` → `human_pass_record_result` →
  `claim_complete`, group create/invite/preview/join/leave, member remove and promote; the three
  verification providers (mock, manual review, vendor adapter) and their server routes; Public
  World, Claim, Start group, Join group, You're on Earth on web and mobile.
- **M2 Messenger** — conversations and idempotent messaging, read state, reactions, media
  messages, the offline outbox; chats list, new chat, group and direct threads, conversation info
  on both clients.
- **M3 Private video + Guest** — rooms, participants, guest sessions and guest links, LiveKit
  token minting and webhook reconciliation, the Active Room and the Guest room web
  (`/live/[token]`), guest conversion.
- **M4 Live** — Live discovery, Open up, consent-gated visibility widening, moderator transfer,
  dynamic room titles, `notify_live` with dedupe and cooldowns, Live Home on both clients.
- **M5 Feed** — posts, post media, reactions, hides, feed candidates and ranking, the SCREEN 02
  presence row, composer, post detail, profile, notifications, search.
- **M6 Radius + Earth map** — PostGIS areas and places (SF seed), `area_resolve`,
  `context_set_area`, location shares with `map_objects`; MapLibre on web and `react-native-maps`
  on mobile, city switch, share duration, visible-shares list.
- **M7 Safety / hardening** — reports, blocks, rate limits, audit log, age gating; block/report/
  hide/remove on every surface including a named Guest in a room; Settings and recovery; the
  authorization matrix over every table and the privacy audit (no raw GPS persisted).

70 migrations in `supabase/migrations/`, every table with RLS and explicit grants, every mutation
a `security definer` RPC returning the DTO shape in `packages/domain/src/dto`. The server tier
(`packages/server`, mounted at `apps/web/app/api/[...earth]`) holds LiveKit tokens and webhooks,
Human verification, feed ranking and presence, Live discovery, signed media access, push dispatch,
room sweeps, daily metrics, analytics ingest, RTC diagnostics and account deletion, as pure
handlers with injected dependencies. Docs: `README.md`, `docs/DEPLOYMENT.md`,
`docs/architecture/ARCHITECTURE.md` (§17 records every deliberate deviation), `DB_API.md`,
`e2e/README.md`.

### Tests, by tier

Final run, 2026-09-04, branch `claude/earth-v1-build-spec-n9wgrk`, Postgres 16 on
127.0.0.1:5432. `pnpm test` (turbo, 26 tasks) exit 0.

| Tier / workspace                                                            | Files | Tests                 |
| --------------------------------------------------------------------------- | ----- | --------------------- |
| `@earth/db-tests` (authorization matrix, RPC invariants, integration flows) | 73    | 4259                  |
| `@earth/permissions` (mirror + shared fixtures)                             | 8     | 2336                  |
| `earth-web` (state + components via `react-dom/server`)                     | 71    | 411                   |
| `earth-mobile` (state + screens through `test/render.tsx`)                  | 64    | 401                   |
| `@earth/observability`                                                      | 6     | 287                   |
| `@earth/domain`                                                             | 19    | 276                   |
| `@earth/server`                                                             | 20    | 207                   |
| `@earth/api`                                                                | 14    | 153                   |
| `@earth/auth`                                                               | 9     | 141                   |
| `@earth/realtime`                                                           | 10    | 108                   |
| `@earth/ui`                                                                 | 6     | 82                    |
| `@earth/analytics`                                                          | 9     | 81                    |
| `@earth/config`                                                             | 6     | 65                    |
| root (`pnpm test:root`: migrate runner, local-stack)                        | 9     | 103 passed, 7 skipped |
| `@earth/e2e` (Playwright journeys)                                          | 14    | 17                    |

8927 tests in total (8910 unit/DB + 17 end to end). The 7 root skips are the live `stack.test.ts`
cases, which need a running stack; run separately with the stack up they pass —
`EARTH_REQUIRE_STACK=1 pnpm vitest run scripts/local-stack/stack.test.ts` exit 0, 9 passed.

### Final gate (2026-09-04)

Every command from `/home/user/earth`, in order, exit code observed.

| Gate                                                                    | Result                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                        | 0 — lockfile unchanged by the fix waves                              |
| `pnpm format:check`                                                     | 0 — no file needed reformatting, `pnpm format` never run             |
| `pnpm lint`                                                             | 0 (15/15 tasks)                                                      |
| `pnpm typecheck`                                                        | 0 (15/15 tasks)                                                      |
| `pnpm exec tsx scripts/db/migrate.ts --reset`                           | 0 — shim + 70 migrations + 3 seeds onto a fresh `earth_local`        |
| `pnpm test`                                                             | 0 (26/26 tasks; counts above)                                        |
| `pnpm --filter earth-web run build`                                     | 0 — 26 routes                                                        |
| `EXPO_NO_TELEMETRY=1 CI=1 … export:check` (iOS) and `export:check:android` | 0 / 0 — one 14 MB Hermes bundle each; `.expo-export-check` deleted |
| `pnpm build` (root, M0 gate)                                            | 0                                                                    |
| `bash scripts/local-stack/down.sh` → `pnpm db:test:clean` → `pnpm e2e`  | 0 / 0 / 0 — **17/17 journeys, three consecutive runs, no retries**    |
| stray-process check (`next-server`, `postgrest`, `gotrue`, `livekit-server`, `mailpit`, `gateway.mjs`) | none left, no listener on 3000/54321/8025/1025/7880 |

Final `pnpm e2e` (2.4 min, 2 workers): `00-smoke` health 51 ms, gateway 16 ms, wordmark 595 ms ·
`00b-harness` claim 3.1 s, sign-in 710 ms · E2E 1 Start Earth 4.3 s · E2E 2 Join group 6.7 s ·
E2E 3 Group chat 38.1 s · E2E 4 Video 13.9 s · E2E 5 Friend Live 26.4 s · E2E 6 Dynamic Live title
22.2 s · E2E 7 Guest 8.4 s (link tap → in the room, inside the spec §112 15 s target) ·
E2E 8 Guest conversion 12.3 s · E2E 9 Audience integrity 13.1 s · E2E 10 Block 42.5 s ·
E2E 11 Radius 1.9 s · E2E 12 Live consent 12.3 s.

The gate's **first** e2e pass was not clean, and the failure was a real product defect, not a
flake: E2E 6 and E2E 9 each failed on the first attempt and passed on retry, both at
`Add Friend → Requested`. See REL-01 — diagnosed, fixed, and the suite then ran clean three times
in a row (four including the `pnpm test` pass).

### Audit findings — both waves

**Wave 1 (§128 adversarial review). Blocking — all seven fixed.**

| #         | Finding                                                                                                | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| INV128-01 | `earth.room_json` rendered a private group's name as `contextTitle` to anyone who could discover the room | **Fixed** in two steps. `0999` gated the title on being in the room; that was not enough, because both room screens join a Live as a viewer first, so an outsider held a seat before reading anything. `1000_fix_room_json_context_title_for_seated_outsiders.sql` makes the predicate membership, not presence: a seat is not membership. Pinned by `supabase/tests/src/verify/audience.test.ts` and `e2e/journeys/05-friend-live.spec.ts:242`. |
| INV128-02 | `notify_live` pushed `group_live` titled "<private group> is live" to non-members                       | **Fixed** — `0970` chooses the copy per recipient; non-members fall through to `friend_live` / `multi_live` with `contextTitle: null`.                                                                                                                                                                                                                                                                                                                                |
| INV128-03 | A `temporary_context` location share kept reaching whoever was in the room after it was widened        | **Fixed** — `0971` revokes every live room-scoped share the moment `rooms.visibility` rises.                                                                                                                                                                                                                                                                                                                                                                          |
| SEC-001   | The signed-media route every post media URL points at did not exist                                    | **Fixed** — `0972` (`earth.media_readable_by`, `public.media_access_grant`), `packages/server/src/media/signed.ts`, route `media.signed`.                                                                                                                                                                                                                                                                                                                             |
| DEP-01    | `supabase/config.toml` declared `major_version = 16`, which the Supabase CLI rejects                    | **Fixed** — now 17, pinned by `scripts/local-stack/env.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                                     |
| DEP-02    | `0002_schemas.sql` revoked on `public.earth_migrations` with no existence guard, aborting `db push`      | **Fixed** — the revoke is inside a `to_regclass` guard.                                                                                                                                                                                                                                                                                                                                                                                                              |
| DEP-03    | Two pairs of migrations shared a numeric prefix, which the hosted ledger cannot represent               | **Fixed** — renamed, plus `duplicateMigrationVersions` in `scripts/db/migrate-core.ts` so the runner fails on any future duplicate.                                                                                                                                                                                                                                                                                                                                   |

**Wave 1. Major — six fixed, two partly fixed.**

| #      | Finding                                                          | Disposition                                                                                                                                                                        |
| ------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SCR-01 | The SCREEN 02 presence row could never render                    | **Fixed** — `0973_feed_presence.sql`, `packages/domain/src/feed/presence.ts`, `packages/server/src/feed/presence.ts`, prepended by `apps/web/components/feed/HomeFeed.tsx`.          |
| SCR-02 | SCREEN 23 (notifications) had no navigation affordance on the web | **Fixed** — `NotificationsButton.tsx` + `useUnreadCount.ts`, with `apps/web/lib/routes.audit.test.ts` asserting every route is reachable.                                            |
| SCR-03 | SCREEN 21 (search) had no persistent entry point on the web      | **Fixed** — `SearchButton.tsx`, same route audit.                                                                                                                                   |
| DEP-10 | The README had no end-to-end deploy instructions                 | **Fixed** — `docs/DEPLOYMENT.md` plus the README's Deploy section.                                                                                                                  |
| DOD-01 | The §127 done-statements were proven at runtime on the web only  | **Partly fixed** — `apps/mobile/test/` and the `.test.tsx` files now mount the real mobile screens (64 files / 401 tests). Open: no device-level harness, so journeys stay web-only. |
| DOD-02 | The Storage half of the messenger executed nowhere               | **Partly fixed** — `0997` creates the buckets and policies everywhere, `scripts/local-stack/storage.mjs` serves Storage under them, 15 tests walk it. Open: no journey sends a photo or voice message. |

**Wave 2 (the deployment/safety fix wave). Seven closed.**

| #       | Finding                                                          | Disposition                                                                                                                                                                                                                                                                                     |
| ------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-002 | Spec §81: a *specific Guest* in a room could not be reported     | **Fixed** — the participants sheet builds the report target per row (`human` by `humanId`, `guest` by guest-session id) on both clients; `apps/{web,mobile}/components/rooms/ParticipantsSheet.test.tsx` and `supabase/tests/src/safety/participant-reports.test.ts`.                              |
| SEC-003 | Spec §84 age-gating architecture was absent                      | **Fixed** — `1020_age_gate.sql`: `humans.age_bracket` (`unknown`/`adult`/`minor`, written only by the verification service role), `app_settings.minimum_age_policy` defaulting closed to `18_plus`, and `earth.age_policy_allows()` consulted by `claim_complete` (`age_not_allowed`, HTTP 403). Tests in `supabase/tests/src/safety/age-gate.test.ts`. |
| DEP-04  | Association files were committed placeholders; the generator ran nowhere | **Fixed** — `apps/web/app/.well-known/{apple-app-site-association,assetlinks.json}/route.ts` serve them from the environment at request time; the placeholder files and the unused generator script are gone. Tests in `apps/web/lib/deeplinks/well-known.test.ts`.                        |
| DEP-05  | The `production` EAS profile carried only `EXPO_PUBLIC_APP_ENV`  | **Fixed** — `eas.json` links the production EAS environment and `app.config.ts` refuses a production build whose public env is incomplete; `apps/mobile/app.config.test.ts`.                                                                                                                     |
| DEP-06  | `EAS_PROJECT_ID` was the all-zero placeholder                    | **Fixed** — read from the environment, absent-or-placeholder fails a production config; the deploy workflow passes `vars.EAS_PROJECT_ID`.                                                                                                                                                        |
| DEP-07  | No Android FCM configuration                                     | **Fixed** — `android.googleServicesFile` wired to `GOOGLE_SERVICES_JSON`, required for a production Android build.                                                                                                                                                                               |
| DEP-08  | No Google Maps API key for `react-native-maps`                   | **Fixed** — `android.config.googleMaps.apiKey` from the environment, required for a production Android build.                                                                                                                                                                                   |
| DEP-09  | `NEXT_PUBLIC_SENTRY_DSN` was inlined with no browser client      | **Fixed** — `apps/web/instrumentation-client.ts` initialises Sentry in the browser on the same release string as the server tier, and no-ops when the DSN is unset; `apps/web/instrumentation.test.ts`.                                                                                           |
| DEP-12  | The Vercel cron declarations could not drive the routes they name | **Fixed** — `apps/web/lib/server/cron.ts` translates Vercel's `GET` + `Authorization: Bearer` into the router's `POST` + `x-earth-cron-secret`; `apps/web/app/api/[...earth]/cron.test.ts` reads the schedule out of `vercel.json` so a cron without a handler fails the suite.                   |

**Wave 3 (this gate). One found, one fixed.**

| #      | Finding                                                                    | Disposition                                                                                                                                                                                                                                                                                                                          |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| REL-01 | A friend request could be recorded and then vanish from the screen (SCREEN 22) | **Fixed.** `useProfileActions` wrote the RPC answer with `queryClient.setQueryData`, but the `profile_get` the screen starts on arrival was often still in flight; react-query writes a late answer over a cache write, so `Requested` reverted to `Add Friend` with nothing left to refetch it. Confirmed against the database — the `friend_pending` row existed while the button still read `Add Friend`. `commitProfile` now cancels the read in flight before writing, on web (`apps/web/components/profile/hooks/useProfile.ts`) and mobile (`apps/mobile/features/feed/hooks/useProfile.ts`); regression tests in the sibling `useProfile.test.ts` files fail without the cancel and pass with it. |

### Open, with the reason each is still open

| #                | Still open                                                    | Reason                                                                                                              |
| ---------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| DOD-01 remainder | No mobile end-to-end harness                                  | Maestro/Detox against `scripts/local-stack` is a tier that was never built; mobile is proven by screen tests + export. |
| DOD-02 remainder | No journey sends a photo or a voice message                   | The browser attach/record flows are covered by component tests only; adding them needs new journey fixtures.           |
| DEP-11 remainder | Hosted Auth settings are not asserted against `config.toml`   | Those settings live only in the Supabase dashboard; nothing in this repo can read them.                               |
| —                | Nothing is deployed                                           | No provider account, secret or store listing exists to deploy against; every `docs/DEPLOYMENT.md` procedure is untested in production.  |
| —                | Cron, EAS, FCM and Maps values are placeholders in `.env.example`                  | They are per-project credentials nobody can supply from here; the code now *fails closed* without them rather than shipping a broken build. |
| —                | Other `setQueryData` sites (map shares, notifications, privacy settings) keep the pre-REL-01 shape | Each was left untouched: this gate reproduced the race only on the profile actions, and a blind sweep would change behaviour no test covers. |

### Known limitations

- The local stack has **no Supabase Realtime**: the gateway answers `/realtime/v1/*` with 503 and
  refuses websocket upgrades, so every local and e2e run exercises `@earth/realtime`'s polling
  fallback rather than `postgres_changes`. The production path is configured (DEPLOYMENT.md §1.5)
  but is not exercised by any test here.
- The local stack's **Storage** is `scripts/local-stack/storage.mjs`, not Supabase Storage. It
  holds no rule of its own — every request is authorized by the same `0997` policies — but it is
  not the same implementation, and signed-URL semantics are re-implemented rather than shared.
- The **Human verification vendor adapter is generic**: a fixed wire contract that any vendor is
  mapped onto by configuration. No real vendor has been integrated or tested against.
- Age gating is **architecture, not enforcement of a measured age**: `age_bracket` ships `unknown`
  for everyone and only a verification provider can ever set it, so today the gate admits everyone
  exactly as before. A launch that must exclude minors needs the provider to report age.
- The **mobile client is verified by typecheck, unit/screen tests and a Metro export only**. No
  build ran on a device or simulator, no EAS build was produced, push was never delivered to a
  handset, and `react-native-maps` was never rendered.
- The §127 done-statements are proven end to end **on the web client only** (17 Playwright tests,
  one Chromium project against `apps/web`).
- The Milestone 6 gate is proven at the DB and component tier, not end to end: E2E 11 walks the
  radius switch and E2E 10 walks the map's friend markers, while "the map shows Lives by area" is
  proven by `supabase/tests/src/map-search/map.test.ts` (`map_objects` returns each Live inside the
  bbox at every radius and none outside) and the marker-state tests on both clients. No journey
  walks a Live pin.
- Nothing has been deployed. Every provider account, secret and store submission in
  `docs/DEPLOYMENT.md` is untested against a real project.

### Next steps

1. Deploy: create the Supabase, Vercel, LiveKit, Expo and store accounts and walk
   `docs/DEPLOYMENT.md` end to end. Everything below is downstream of doing this once.
2. Produce a real `eas build` and run it on a device: push delivered to a handset, the Android map
   rendering with the Maps key, deep links resolving against the served association files.
3. Give the verification provider an age signal so SEC-003's gate has something to act on.
4. Extend the journeys where coverage is thin: a photo and a voice message end to end (DOD-02
   remainder), and the map's Live pins (the Milestone 6 gate).
5. Stand up a mobile end-to-end harness (Maestro or Detox against `scripts/local-stack`) so the
   §127 statements are proven on both clients (DOD-01 remainder).
6. Consider applying REL-01's cancel-before-write guard to the other `setQueryData` call sites,
   each with a test that fails without it.

### Earlier status entries (unedited)

- E2E status (2026-09-03, branch claude/earth-v1-build-spec-n9wgrk, local Postgres 16 + the local stack, Chromium from `PLAYWRIGHT_BROWSERS_PATH` with fake media devices): `bash scripts/local-stack/down.sh` exit 0 · `pnpm db:test:clean` exit 0 (dropped 1 scratch database) · `pnpm --filter earth-web run build` exit 0 · `pnpm e2e` (E2E_EXTERNAL_STACK unset, so `e2e/global-setup.ts` ran `up.sh` → 63 migrations + 3 seeds onto a fresh `earth_local`, built and started apps/web on :3000 with `.local/stack.env` + `HUMAN_VERIFICATION_PROVIDER=mock APP_ENV=development`) **exit 0 four times in a row, 17/17 passed each time, no retries and nothing flaky**: runs A-D, 2.5 min each (C and D on the final tree, after `pnpm format:check` reformatted `e2e/journeys/11-radius.spec.ts`). Per spec (run A / run B): `00-smoke` health 79 ms / 47 ms, gateway 17 ms / 19 ms, wordmark 557 ms / 525 ms · `00b-harness` claim 3.0 s / 3.1 s, sign-in 679 ms / 699 ms · E2E 1 Start Earth 3.9 s / 4.2 s · E2E 2 Join group 6.8 s / 6.7 s · E2E 3 Group chat 37.7 s / 37.1 s · E2E 4 Video 14.0 s / 14.2 s · E2E 5 Friend Live 26.5 s / 26.6 s · E2E 6 Dynamic Live title 22.6 s / 22.8 s · E2E 7 Guest 8.6 s / 9.0 s (link tap → in the room 2421 ms / 2509 ms, spec §112 target 15 s) · E2E 8 Guest conversion 13.3 s / 12.3 s · E2E 9 Audience integrity 13.3 s / 13.2 s · E2E 10 Block 42.7 s / 41.9 s · E2E 11 Radius 2.1 s / 2.0 s · E2E 12 Live consent 15.4 s / 15.8 s. No regression from the run: `pnpm --filter @earth/db-tests run test` exit 0 (67 files / 4212 tests) · `pnpm typecheck` exit 0 (15/15) · `pnpm lint` exit 0 (15/15) · `pnpm format:check` exit 0 · `pnpm turbo run test --filter='!@earth/db-tests' --filter='!@earth/e2e'` exit 0 (22/22 tasks: @earth/permissions 2336, earth-web 348, earth-mobile 340, @earth/observability 287, @earth/domain 268, @earth/server 189, @earth/api 153, @earth/auth 141, @earth/realtime 108, @earth/ui 82, @earth/analytics 81, @earth/config 64) · `pnpm test:root` exit 0 (90 passed / 6 skipped = the live `stack.test.ts` suite, stack down at test time). Two harness defects fixed, no product change needed: (1) `e2e/global-setup.ts` started its web server, lost :3000 to a server left over from an earlier session (`EADDRINUSE` in `.local/logs/e2e-web.log`) and the whole run went green against that stale build — setup now refuses to start when anything already answers `/api/health` and races the server's exit against the readiness wait, so a dead server fails the run instead of handing it to a stranger; (2) `uniqueName()` in `e2e/fixtures/people.ts` built every name from one per-process `runId()` plus a counter, so two journeys' people differed by one character (`Ada mtm0cjeq55043` / `Ada mtm0cjeq5504w`, trigram similarity 0.8) and `search` (0900) answered E2E 10's post-block search with another journey's Ada — names now carry their own random tail (similarity ≤ 0.24), which is what journey independence actually requires. CI (`.github/workflows/ci.yml`, job `e2e`) now runs the journeys exactly this way — stack binaries fetched and cached, Chromium installed, one `pnpm stack:up` + `stack.test.ts` + `pnpm stack:down` smoke pass, then plain `pnpm e2e` with `E2E_EXTERNAL_STACK` unset (it used to start the stack and the web app itself and run the suite against them) — and `e2e/README.md` matches. Not claimed: the M6 gate, whose second half (“map shows Lives by area”) no journey covers — E2E 11 proves the radius half and E2E 10 walks the map's friend markers, and the map's Live pins are still unwalked.
- M0 status (2026-09-03, clean clone equivalent: node_modules removed, `pnpm install --frozen-lockfile` exit 0, local Postgres 16): `pnpm format:check` exit 0 (all files formatted) · `pnpm lint` exit 0 (15/15 tasks) · `pnpm typecheck` exit 0 (15/15) · `pnpm test` exit 0 (25/25 tasks; @earth/db-tests 88 passed, @earth/domain 268, root scripts 89 passed / 6 skipped = the live `stack.test.ts` suite because the local stack was not running) · `pnpm build` exit 0 (earth-web) · `pnpm --filter earth-mobile export:check` exit 0 (iOS bundle, 1106 modules) · `git status --porcelain | wc -l` = 24 (every entry untracked: first commit pending; .gitignore covers .local, node_modules, .next, .expo, .expo-export-check, apps/mobile/ios, apps/mobile/android) · secret scan for `sk_live` / `eyJhbGciOi` clean (only synthetic test fixtures). Note: `earth.current_human_id()` and friends land with the 01xx identity tables; M0 helpers are `earth.jwt_claims`, `is_anonymous_jwt`, `is_service_role`, `utc_now`, `raise`, `sha256_hex`, `random_token`, `request_headers`, `client_address`, `rate_limit*`. CI workflow exists but has not yet run remotely (no commits on the branch).
- Backend status (2026-09-03, local Postgres 16, branch claude/earth-v1-build-spec-n9wgrk): `pnpm exec tsx scripts/db/migrate.ts --reset` exit 0 (shim + 61 migrations + 3 seeds onto a fresh earth_local) · `pnpm format` exit 0 (136 files rewritten) then `pnpm format:check` exit 0 · `pnpm lint` exit 0 (15/15 tasks) · `pnpm typecheck` exit 0 (15/15) · `pnpm test` exit 0 (25/25 tasks: @earth/db-tests 67 files / 4212 tests, @earth/permissions 2336, @earth/domain 268, @earth/observability 287, @earth/server 189, @earth/api 153, @earth/auth 141, @earth/realtime 108, @earth/ui 82, @earth/analytics 81, @earth/config 64, earth-web 315, earth-mobile 340, root scripts 89 passed / 6 skipped = the live `stack.test.ts` suite (stack down at test time), @earth/e2e 2 passed after the fix below) · `pnpm --filter earth-web run build` exit 0 · `EXPO_NO_TELEMETRY=1 CI=1 pnpm --filter earth-mobile run export:check` exit 0 (iOS bundle 14 MB; `.expo-export-check` removed) · HTTP walk over the local stack (`scripts/local-stack/up.sh`, built web on :3000 with `.local/stack.env` + `HUMAN_VERIFICATION_PROVIDER=mock APP_ENV=development`, two real GoTrue users via email OTP through Mailpit, RPCs over PostgREST through the gateway): claim_start(start_group) → claim_set_identity → POST /api/claim/verification/start (mock, `verified`) → GET /api/claim/verification/:id → claim_complete → group_invite_create → second user claim_start(join_group, token) → identity → verification → claim_complete (same groupId/conversationId) → message_send by both (idempotent replay returns the same id) → messages_since sees both → room_start(group) → POST /api/rooms/:id/token (LiveKit HS256 JWT verified with the dev keys: identity `h:<human>`, `video.room` = room id, canPublish, TTL 7200) → second user room_join(watching) + token → GET /api/feed?scope=friends 200 with a live card ("Verify Crew is live") → GET /api/live?scope=friends 200 — every request 200; visitor: /api/feed?scope=world 200 (8 seed cards), /api/feed?scope=friends 401, /api/rooms/:id/token 401; no error lines in web/PostgREST/GoTrue logs; `down.sh` exit 0. No client↔SQL↔DTO mismatch found (0994_http_verify.sql not needed). Fixed: `pnpm test` from a shell without the stack environment failed in @earth/e2e — Playwright's standalone `next dev` had no server-tier env, so `/api/health` answered 503 until the 180 s webServer timeout, and the smoke test still expected the pre-server-tier body `{ok, service}` (`e2e/playwright.config.ts` now loads `.local/stack.env` or `.env` for the server it starts; `e2e/journeys/00-smoke.spec.ts` asserts `serverTier: 'ready'`). Open at the time of that run: the `avatars` / `media` / `voice` storage buckets (ARCHITECTURE §5) were declared nowhere. Closed since — see the Storage status entry below.
- Storage status (2026-09-03, audit finding DOD-02, local Postgres 16 + the local stack): the Storage half of the messenger — photo/video/file messages, voice notes, post media and the claim avatar — now executes. Before: `supabase/migrations/0997_storage_buckets.sql` guarded on the `storage` schema, `psql earth_local -Atc "select count(*) from pg_namespace where nspname='storage'"` answered `0`, so neither the three buckets nor the five `storage.objects` policies were ever created, `scripts/local-stack` had no Storage service (the gateway answered `/storage/v1/*` with 501), and no test anywhere uploaded a byte. Three changes: (1) `supabase/tests/sql/supabase_shim.sql` block 6 gives a plain Postgres the `storage` schema Supabase's Storage service owns (`buckets`, `objects`, `foldername()/filename()/extension()`, RLS, grants), so 0997 applies verbatim on the local stack and in every test template — it is skipped on a managed database and on any database that already has `storage`; (2) `scripts/local-stack/storage.mjs` is a Storage service mounted on the gateway at `/storage/v1` (upload, signed URL, signed/public/authenticated download, delete) writing to `.local/storage/<bucket>/<key>`, which holds **no rule of its own**: every request opens a transaction as the role its JWT carries, exactly as PostgREST does, and the 0997 policies decide — `up.sh` empties the object directory whenever it recreates the database; (3) two tests pin it. `supabase/tests/src/storage/objects.test.ts` (6 tests) asserts the buckets and their limits, that RLS is on, that exactly the five `earth_*` policies exist with the `(storage.foldername(name))[1] = (earth.current_human_id())::text` comparison in each, and then walks the rule row by row — a Human writes only under its own human id in all three buckets, a visitor / Guest / claiming credential writes nowhere, private objects are visible to their owner alone while avatars are visible to everyone, and only the owner may move or delete. `scripts/local-stack/storage.test.ts` (9 tests) drives a real `@supabase/storage-js` client over a real socket against a freshly migrated database: a photo lands on disk with its row, a voice note sent the browser's way (multipart Blob) lands too, an upload into another member's folder is refused by row level security **and writes no byte**, a signed URL round-trips through a plain `fetch` while a forged token is refused, the service role signs (the `GET /api/media/:bucket/:key*` path of spec §104) and another member cannot, and a public avatar is readable with no credential. Live-stack walk: `pnpm stack:up` → `select count(*) from storage.buckets` = 3, `pg_policies where schemaname='storage'` = 5, `POST /storage/v1/object/media/<own human>/live-walk.jpg` with a session JWT → `{"Id":…,"Key":"media/…"}` and 15 bytes in `.local/storage`, the same POST into another Human's folder → `403 {"error":"Unauthorized","message":"new row violates row-level security policy"}`, `POST /object/sign/...` → signed URL that returns the bytes as `image/jpeg`; `EARTH_REQUIRE_STACK=1 pnpm exec vitest run scripts/local-stack/stack.test.ts` exit 0 (9 passed). Still open: no Playwright journey sends a photo or a voice message — E2E 3 covers text, replies, reactions and read receipts only — so the browser-side attach and record flows (`apps/web/components/chats/ConversationScreen.tsx:166,203`) remain covered by component tests rather than end to end, and the mobile equivalents likewise. Also note: a database kept across this change with `KEEP_DB=1` has 0997 recorded as applied from when it was a no-op; one `pnpm stack:up` (which resets by default) creates the buckets and policies.
