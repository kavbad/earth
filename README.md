# Earth

Earth is a social product built around real Humans: every account is a verified person,
groups anchor admission, conversations are private by default, and Live video rooms can be
opened up from a group to friends, a neighborhood, a city, or the whole world. Feeds and the
Earth map surface what is happening around you at the radius you choose.

The product specification is `docs/product/EARTH_V1_SPEC.md`; the binding technical contract
is `docs/architecture/ARCHITECTURE.md` (plus ADRs in `docs/architecture/`).

## Layout

```text
apps/
  mobile/     Expo 57 + expo-router (iOS + Android, dev client)
  web/        Next.js 16 app router: public World, links, guest rooms, member web client, /api server tier
packages/
  config/     zod-validated env, feature flag keys, constants
  domain/     enums, types, DTO schemas, pure logic (feed ranking, naming, audience, cursors)
  permissions/ canViewObject mirror of DB policy + shared fixtures
  api/        EarthClient: typed wrapper over supabase-js + server tier
  auth/       session helpers, claim flow state machine, Human verification providers
  realtime/   conversation/room/presence channels with polling fallback, LiveKit helpers
  analytics/  AnalyticsProvider + event contract, PostHog / noop / first-party adapters
  observability/ ErrorMonitor, Sentry adapters, structured logger
  ui/         design tokens, typography, spacing, copy strings, formatters
  server/     pure server-tier handlers (tokens, webhooks, push, verification, feed, sweeps)
supabase/
  migrations/ ordered SQL migrations (the database is the source of truth for rules)
  seed/       development fixtures (never applied in production)
  tests/      vitest + pg authorization matrix and RPC invariants (@earth/db-tests)
  functions/  README only (see ADR-001)
e2e/          Playwright journeys against the local stack (@earth/e2e)
scripts/      local-stack, database migrate/reset/seed
docs/         architecture/ and product/
tasks/        build plan and lessons
```

## Prerequisites

- Node 22 (`.nvmrc`), pnpm 10 (`packageManager` in `package.json`)
- Postgres 16 with `postgis`, `pgcrypto`, `pg_trgm` (and optionally `pgtap`) on `127.0.0.1:5432`
- Xcode / Android Studio for a mobile dev client (Expo Go is not supported)

## Run

```bash
pnpm install                      # installs every workspace
cp .env.example .env              # fill in values; see docs/architecture/ARCHITECTURE.md §14
pnpm stack:up                     # local stack: Postgres, PostgREST, GoTrue, LiveKit, Mailpit, gateway (add --with-web for Next.js)
pnpm db:reset                     # recreate the local database from migrations (+ seed outside production)
pnpm dev:web                      # Next.js on http://localhost:3000
pnpm dev:mobile                   # Expo dev server (use a dev client build)
pnpm stack:down
```

## Verify

```bash
pnpm lint                         # ESLint 9 flat config across the monorepo
pnpm typecheck                    # TypeScript 5.9 strict
pnpm test                         # vitest unit tests in every package
pnpm build                        # Next.js production build
pnpm db:test                      # database tests (needs Postgres)
pnpm e2e                          # Playwright journeys (needs the stack or starts the web app)
pnpm --filter earth-mobile export:check   # Metro bundle for iOS
pnpm format:check
```

## Docs

- Product spec: `docs/product/EARTH_V1_SPEC.md`
- Architecture contract: `docs/architecture/ARCHITECTURE.md`
- ADR-001 (server tier in Node route handlers): `docs/architecture/ADR-001-server-tier.md`
- Build plan: `tasks/todo.md`

## Local stack

`scripts/local-stack` runs everything the apps and the e2e journeys need on one machine, without
Docker or the Supabase CLI (ARCHITECTURE.md §15):

| Service                                     | Port        | Notes                                                                                |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------------------------ |
| Postgres 16 (system service)                | 5432        | database `earth_local`; `up.sh` starts cluster `16/main` if nothing listens          |
| Gateway (`scripts/local-stack/gateway.mjs`) | 54321       | one Supabase-shaped origin: `/rest/v1` → PostgREST, `/auth/v1` → GoTrue              |
| PostgREST 13.0.4                            | 3001        | schema `public`, anon role `anon`, JWT secret shared with GoTrue                     |
| GoTrue 2.185.0 (Supabase Auth)              | 9999        | anonymous sign-ins, email OTP (6 digits) through Mailpit, templates from the gateway |
| LiveKit 1.9.1 (`--dev`)                     | 7880        | API key `devkey` / secret `secret`                                                   |
| Mailpit 1.28.0                              | 1025 / 8025 | SMTP / HTTP API + UI (`http://localhost:8025`)                                       |
| Next.js (`apps/web`)                        | 3000        | not started by default; `pnpm stack:up:web` or `pnpm dev:web`                        |

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
`scripts/db/migrate.ts` applies the Supabase shim (roles, `auth.uid()`, default privileges) and
`supabase/migrations` and, outside production, `supabase/seed`.

Limitations, by design: Supabase **Realtime** and **Storage** are not part of the local stack. The
gateway answers `/realtime/v1/*` with 503 (websocket upgrades are refused) so `@earth/realtime`
switches to its polling fallback, and `/storage/v1/*` with 501. Binaries are pinned for Linux
x86_64 (the sandbox and CI); on another platform install them into `.local/bin` by hand.

### CI and deploy

`.github/workflows/ci.yml` runs on every push to `main` and every pull request: `check` (lint,
typecheck, `format:check`, package unit tests), `db` (root script tests + `pnpm db:test` against a
`postgis/postgis:16-3.4` service container), `web-build`, `mobile-export` (`expo export`), and
`e2e` (fetches the binaries, `pnpm stack:up`, builds and starts the web app with
`.local/stack.env`, runs `pnpm e2e`; traces and stack logs are uploaded on failure).

`.github/workflows/deploy.yml` runs on pushes to `main` and manually: `supabase db push`
(`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`), a Vercel deploy of
`apps/web` (`VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`), and — only when the
`mobile_build` input is set — `eas build --non-interactive --profile production` (`EXPO_TOKEN`).
Secret names are placeholders to configure in the repository's `production` environment.
