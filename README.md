# Earth

Earth is a social product built around real Humans: every account is a verified person,
groups anchor admission, conversations are private by default, and Live video rooms can be
opened up from a group to friends, a neighborhood, a city, or the whole world. Feeds and the
Earth map surface what is happening around you at the radius you choose.

The product specification is `docs/product/EARTH_V1_SPEC.md`; the binding technical contract
is `docs/architecture/ARCHITECTURE.md` (plus ADRs and §17, the record of where the build
deliberately deviated). Deployment is `docs/DEPLOYMENT.md`.

## Layout

```text
apps/
  mobile/     Expo 57 + expo-router (iOS + Android, dev client)
  web/        Next.js 16 app router: public World, links, guest rooms, member web client, /api server tier
packages/
  config/     zod-validated env, feature flag keys, constants
  domain/     enums, types, DTO schemas, pure logic (feed ranking, presence, naming, audience, cursors)
  permissions/ canViewObject mirror of DB policy + shared fixtures
  api/        EarthClient: typed wrapper over supabase-js + server tier
  auth/       session helpers, claim flow state machine, Human verification providers
  realtime/   conversation/room/presence channels with polling fallback, LiveKit helpers
  analytics/  AnalyticsProvider + event contract, PostHog / noop / first-party adapters
  observability/ ErrorMonitor, Sentry adapters, structured logger
  ui/         design tokens, typography, spacing, copy strings, formatters
  server/     pure server-tier handlers (tokens, webhooks, push, verification, feed, media, sweeps)
supabase/
  migrations/ 69 ordered SQL migrations (the database is the source of truth for rules)
  seed/       development fixtures (never applied in production)
  tests/      vitest + pg authorization matrix and RPC invariants (@earth/db-tests)
  functions/  README only (see ADR-001)
e2e/          Playwright journeys against the local stack (@earth/e2e)
scripts/      local-stack, database migrate/reset/seed
docs/         DEPLOYMENT.md, architecture/ and product/
tasks/        build plan, review, and lessons
```

## Prerequisites

- Node 22 (`.nvmrc`), pnpm 10 (`packageManager` in `package.json`)
- Postgres 16 with `postgis`, `pgcrypto`, `pg_trgm` (and optionally `pgtap`) on `127.0.0.1:5432`
- Xcode / Android Studio for a mobile dev client (Expo Go is not supported)

## Run

```bash
pnpm install                      # installs every workspace
cp .env.example .env              # fill in values; see docs/architecture/ARCHITECTURE.md §14
pnpm stack:up                     # local stack: Postgres, PostgREST, GoTrue, Storage, LiveKit, Mailpit, gateway (add --with-web for Next.js)
pnpm db:reset                     # recreate the local database from migrations (+ seed outside production)
pnpm dev:web                      # Next.js on http://localhost:3000
pnpm dev:mobile                   # Expo dev server (use a dev client build)
pnpm stack:down
```

## Verify

```bash
pnpm format:check                 # Prettier 3 (docs/ and tasks/ are hand-authored and ignored)
pnpm lint                         # ESLint 9 flat config across the monorepo
pnpm typecheck                    # TypeScript 5.9 strict
pnpm test                         # every workspace: unit + component + DB + e2e (turbo)
pnpm --filter earth-web run build # Next.js production build
pnpm --filter earth-mobile run export:check   # Metro bundle for iOS (writes .expo-export-check)
pnpm db:test                      # database tests only (needs Postgres)
pnpm e2e                          # Playwright journeys only (starts and stops the stack itself)
```

`pnpm test` is the whole suite and takes a few minutes because it includes the DB tests and the
Playwright journeys. For the fast loop — what CI's `check` job runs — use
`pnpm turbo run test --filter='!@earth/db-tests' --filter='!@earth/e2e'`.

### Tests, by tier

Counts from the full local run recorded in `tasks/todo.md` (Review):

| Tier               | Command / workspace                                    | Tests                 |
| ------------------ | ------------------------------------------------------ | --------------------- |
| Database           | `pnpm db:test` (`@earth/db-tests`)                     | 4245 in 71 files      |
| Permissions mirror | `@earth/permissions`                                   | 2336                  |
| Web client         | `earth-web`                                            | 376                   |
| Mobile client      | `earth-mobile`                                         | 379                   |
| Observability      | `@earth/observability`                                 | 287                   |
| Domain             | `@earth/domain`                                        | 274                   |
| Server tier        | `@earth/server`                                        | 207                   |
| API client         | `@earth/api`                                           | 153                   |
| Auth               | `@earth/auth`                                          | 141                   |
| Realtime           | `@earth/realtime`                                      | 108                   |
| UI                 | `@earth/ui`                                            | 82                    |
| Analytics          | `@earth/analytics`                                     | 81                    |
| Config             | `@earth/config`                                        | 64                    |
| Root scripts       | `pnpm test:root` (migrate runner, local-stack helpers) | 103 passed, 7 skipped |
| End to end         | `pnpm e2e` (`@earth/e2e`)                              | 17 Playwright tests   |

Database tests build one template database per run and give every file its own scratch copy; they
impersonate `Visitor / Guest / Human owner / group member / non-member / friend / blocked` and cover
every exposed table (spec §114). The permissions package and the DB share the same JSON fixtures, so
the TypeScript mirror cannot drift from the policies.

### End-to-end journeys

`e2e/journeys/` is the twelve spec §116 journeys plus two harness files, walked against a real
stack in Chromium with fake media devices and real email OTP through Mailpit:

| File                            | Journey                                                    |
| ------------------------------- | ---------------------------------------------------------- |
| `00-smoke.spec.ts`              | the web app and the gateway answer; Home renders           |
| `00b-harness.spec.ts`           | one Human claimed through the real claim UI                |
| `01-start-earth.spec.ts`        | E2E 1 — Visitor → World → Claim → Start group → share      |
| `02-join-group.spec.ts`         | E2E 2 — invite → verify → chat                             |
| `03-group-chat.spec.ts`         | E2E 3 — realtime send/receive/reply                        |
| `04-video.spec.ts`              | E2E 4 — group room, second Human joins                     |
| `05-friend-live.spec.ts`        | E2E 5 — open up to Friends, a friend discovers and joins   |
| `06-dynamic-title.spec.ts`      | E2E 6 — "A is live" → "A + B are live"                     |
| `07-guest.spec.ts`              | E2E 7 — browser Guest joins from a link, no account        |
| `08-guest-conversion.spec.ts`   | E2E 8 — Guest → Claim CTA → group-anchored membership      |
| `09-audience-integrity.spec.ts` | E2E 9 — a Friends post never reaches a stranger            |
| `10-block.spec.ts`              | E2E 10 — block removes DM, discovery and location          |
| `11-radius.spec.ts`             | E2E 11 — Friends / Neighborhood / City / World scoping     |
| `12-live-consent.spec.ts`       | E2E 12 — camera into a World room requires acknowledgement |

They walk `apps/web` only (one `Desktop Chrome` project). The mobile client's runtime gate is
`pnpm --filter earth-mobile test` — pure state plus screens mounted through
`apps/mobile/test/render.tsx` — and `expo export` (ARCHITECTURE §17.11).

## Docs

- Product spec: `docs/product/EARTH_V1_SPEC.md`
- Architecture contract: `docs/architecture/ARCHITECTURE.md` (§17 lists every deliberate deviation)
- Database and RPC reference: `docs/architecture/DB_API.md`
- ADR-001 (server tier in Node route handlers): `docs/architecture/ADR-001-server-tier.md`
- Production deployment: `docs/DEPLOYMENT.md`
- Build plan and review: `tasks/todo.md`; corrections distilled into `tasks/lessons.md`
- End-to-end harness: `e2e/README.md`

## Local stack

`scripts/local-stack` runs everything the apps and the e2e journeys need on one machine, without
Docker or the Supabase CLI (ARCHITECTURE.md §15):

| Service                                     | Port        | Notes                                                                                                              |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Postgres 16 (system service)                | 5432        | database `earth_local`; `up.sh` starts cluster `16/main` if nothing listens                                        |
| Gateway (`scripts/local-stack/gateway.mjs`) | 54321       | one Supabase-shaped origin: `/rest/v1` → PostgREST, `/auth/v1` → GoTrue, `/storage/v1` → the local Storage service |
| PostgREST 13.0.4                            | 3001        | schema `public`, anon role `anon`, JWT secret shared with GoTrue                                                   |
| GoTrue 2.185.0 (Supabase Auth)              | 9999        | anonymous sign-ins, email OTP (6 digits) through Mailpit, templates from the gateway                               |
| LiveKit 1.9.1 (`--dev`)                     | 7880        | API key `devkey` / secret `secret`                                                                                 |
| Mailpit 1.28.0                              | 1025 / 8025 | SMTP / HTTP API + UI (`http://localhost:8025`)                                                                     |
| Next.js (`apps/web`)                        | 3000        | not started by default; `pnpm stack:up:web` or `pnpm dev:web`                                                      |

```bash
pnpm stack:fetch                  # download the pinned binaries into .local/bin (up.sh does this on demand)
pnpm stack:up                     # reset earth_local, run GoTrue + earth migrations (+ seeds), start everything
pnpm stack:up:web                 # same, plus `pnpm --filter earth-web dev`
KEEP_DB=1 pnpm stack:up           # keep the database (migrations are idempotent), NO_SEED=1 skips seeds
pnpm stack:otp probe@earth.local  # print the latest 6-digit email code Mailpit received for an address
pnpm stack:down                   # stop every process (pids in .local/pids); the database stays
```

`pnpm e2e` needs none of this by hand: the Playwright harness runs `up.sh`, builds and starts
`apps/web`, then runs `down.sh` (`e2e/README.md`); `E2E_EXTERNAL_STACK=1 pnpm e2e` reuses a stack
that is already up.

`up.sh` writes `.local/stack.env` (dotenv) with everything the apps need — `NEXT_PUBLIC_*` and
`EXPO_PUBLIC_*` pointing at the gateway (`http://localhost:54321`), the `anon` / `service_role`
keys minted from the dev JWT secret (`scripts/local-stack/jwt.ts`), LiveKit dev keys, and
`DATABASE_URL`. Load it with `set -a && source .local/stack.env && set +a` before `pnpm dev:web`,
`pnpm --filter earth-web build` or `pnpm e2e`. `source scripts/local-stack/env.sh` exports the
same values (plus the GoTrue/PostgREST configuration) into the current shell. Logs live in
`.local/logs/<service>.log`.

Database order matters and `up.sh` gets it right: it recreates `earth_local` empty, creates the
`auth` schema, runs GoTrue's own migrations (so `auth.users` is the real GoTrue table), then
`scripts/db/migrate.ts` applies the Supabase shim (roles, `auth.uid()`, the `storage` schema,
default privileges) and `supabase/migrations` and, outside production, `supabase/seed`.

**Storage** is served by the gateway itself (`scripts/local-stack/storage.mjs`): uploads, signed
URLs and public avatar reads work, bytes live under `.local/storage/<bucket>/<key>`, and every
request is authorized by the `storage.objects` policies of `supabase/migrations/0997_storage_buckets.sql`
— the service holds no rule of its own. The object store is emptied whenever `up.sh` recreates the
database.

Limitations, by design: Supabase **Realtime** is not part of the local stack. The gateway answers
`/realtime/v1/*` with 503 (websocket upgrades are refused) so `@earth/realtime` switches to its
polling fallback. Binaries are pinned for Linux x86_64 (the sandbox and CI); on another platform
install them into `.local/bin` by hand.

## CI

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

| Job             | What it runs                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`         | `lint`, `typecheck`, `format:check`, package unit tests (db-tests and e2e excluded)                                                                                 |
| `db`            | root script tests + `pnpm db:test` against a `postgis/postgis:16-3.4` service container                                                                             |
| `web-build`     | `pnpm --filter earth-web build`                                                                                                                                     |
| `mobile-export` | `expo export`                                                                                                                                                       |
| `e2e`           | fetches and caches the stack binaries, installs Chromium, smoke-tests `stack:up`/`stack:down`, then plain `pnpm e2e`; traces and stack logs are uploaded on failure |

## Deploy

`docs/DEPLOYMENT.md` is the full procedure — Supabase project (migrations, anonymous sign-ins,
email/phone OTP, storage buckets, realtime, `app_settings`, launch flags), LiveKit Cloud (keys and
the `/api/livekit/webhook` URL), Vercel (`apps/web` env, crons, `earth.social`), the
`/.well-known` association files, EAS (profiles, credentials, push), the Human verification
provider, PostHog and Sentry — and §11, "What is not automated", which a launch has to close by
hand.

`.github/workflows/deploy.yml` runs on pushes to `main` and manually: `supabase db push`
(`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`), a Vercel deploy of
`apps/web` (`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`), and — only when the
`mobile_build` input is set — `eas build --non-interactive --profile production` (`EXPO_TOKEN`).
Configure those secrets in the repository's `production` environment.
