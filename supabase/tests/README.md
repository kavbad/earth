# @earth/db-tests

Database tests for Earth: the authorization matrix, RPC invariants and integration flows run
against a real Postgres (ARCHITECTURE.md §15). Also home of the Supabase compatibility shim
(`sql/supabase_shim.sql`) that lets a plain Postgres apply `supabase/migrations`.

## Running

Requirements: Postgres 16 with `postgis`, `pgcrypto`, `pg_trgm` available (the local machine's
service on 5432 or CI's `postgis/postgis:16-3.4` container). No Docker, no Supabase CLI.

```sh
pnpm --filter @earth/db-tests test        # or: pnpm db:test
pnpm --filter @earth/db-tests typecheck
pnpm --filter @earth/db-tests lint
```

Connection: `EARTH_TEST_ADMIN_URL` (a superuser URL to the maintenance database, default
`postgres://postgres:postgres@127.0.0.1:5432/postgres`). When unset and `DATABASE_URL` is set
(for example from `.env`), the same server is used with the `postgres` database.

What a run does:

1. `src/vitest.globalSetup.ts` drops leftovers (`earth_ts_<run>_*`), creates
   `earth_tt_<run>` (unique per run, so several runs can share one Postgres), applies `sql/supabase_shim.sql` and every `supabase/migrations/*.sql`
   with the same runner as `pnpm db:reset` (`scripts/db/migrate-lib.ts`, ledger in
   `public.earth_migrations`), then closes the template to connections.
2. Every test file calls `createTestDb()` which clones the template
   (`create database ... template earth_tt_<run>`) into a uniquely named scratch database.
   Files run in parallel in separate processes; scratch databases share nothing.
3. Teardown drops the scratch databases and the template. A crashed run leaves databases behind;
   the next run removes them, or drop them by hand:
   `psql -c "select 'drop database ' || quote_ident(datname) || ' with (force);' from pg_database where datname like 'earth\_test\_%'"`.

## Harness API (`src/harness.ts`)

```ts
import { createTestDb, type TestDb } from './harness'

let db: TestDb
beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.drop()
})

const alice = await db.createAuthUser({ email: 'alice@example.test' }) // auth.users row → id
const guest = await db.createAuthUser({ isAnonymous: true })

// Run SQL as a caller: `set local role` + request.jwt.claims inside a transaction (commit by default).
await db.asRole({ userId: alice }, (client) => client.query('select * from public.posts'))
await db.asRole('visitor', fn, { rollback: true }) // anon role, no sub
await db.asRole('service', fn) // service_role JWT
await db.asRole({ userId: guest, isAnonymous: true }, fn) // Guest credential

// Call an RPC with named arguments; a `returns jsonb` result comes back parsed.
const group = await db.rpc('group_create', { name: 'Weekend Crew' }, { userId: alice })

// Assert a machine error code (errcode P0001, message = code).
await db.expectError(db.rpc('group_get', { group_id: group.id }, 'visitor'), 'not_authenticated')

// Superuser connection for fixtures and assertions (no JWT: counts as the service).
await db.sql.query('select count(*) from private.rate_limits')
```

Conventions the harness relies on (migrations 0002–0005):

- `earth` and `private` have no USAGE for `anon`/`authenticated`. Reach `earth.*` from tests the
  way production does: through a `security definer` function in `public` with
  `set search_path = public, earth, private, pg_temp`, granted to the roles that may call it.
- New objects in `public` carry no privileges for `anon`/`authenticated` and new functions are
  not executable by PUBLIC: every table and RPC needs explicit `grant` statements.
- `earth.*` read-only helpers (`jwt_claims`, `is_anonymous_jwt`, `is_service_role`, `utc_now`,
  `request_headers`, `client_address`) are executable by the API roles so RLS policies can use
  them; the rate-limit functions are not (owner and `service_role` only).
- `earth.is_service_role()` is decided by the JWT `role` claim when a JWT is present. Only a
  session with no JWT (the `sql` client, migrations, seeds) counts as the service by database role.
- Time: `earth.utc_now()` honours `set local earth.now = '<timestamptz>'`, so tests can advance
  the clock (rate-limit windows, room grace periods) inside a transaction.
- Request headers: `earth.client_address()` reads `request.headers` (what PostgREST sets); tests
  simulate a client behind the API with
  `set_config('request.headers', '{"cf-connecting-ip": "203.0.113.9"}', true)`.
- Rate limits (`earth.rate_limit_for_caller`): Humans get the full budget keyed by auth user id;
  Guests (anonymous JWT) and Visitors (keyed by `earth.client_address()`) get half, rounded up.
  Every window stores its own `expires_at`; `earth.rate_limit_prune()` removes expired windows
  only, whatever their length.
- Extensions live in `extensions`; every scratch database has
  `search_path = public, extensions` like the hosted project.

## The Supabase shim (`sql/supabase_shim.sql`)

Creates what hosted Supabase provides and a plain Postgres lacks: roles `anon`, `authenticated`,
`service_role` (nologin), `authenticator` (login, password `postgres`, member of the three),
optional `supabase_admin`; schemas `auth` and `extensions`; `auth.users` (only when absent: a
compatible subset of GoTrue's columns, its generated `confirmed_at` and its uniqueness on email
and phone, never altered); `auth.uid()`, `auth.jwt()`, `auth.role()`, `auth.email()`; and
Supabase's permissive default privileges on `public` so migration 0002's revokes are exercised
locally. Every block is idempotent and returns early on a Supabase-managed database, and
`scripts/db/migrate.ts` never applies the file there. Re-applying the file to a migrated database
(for example by hand with psql) is safe: the permissive defaults are only installed until 0002
has run.

The local stack applies GoTrue's own migrations before the shim (`scripts/local-stack/up.sh`:
prepare-db → `gotrue migrate` → `migrate.ts`), so there GoTrue owns the real `auth.users`. With
`KEEP_DB=1`, or after a bare `pnpm db:reset`, GoTrue migrates on top of the shim's table
instead; `src/gotrue.test.ts` runs GoTrue's real migration files in both orders (it needs
`.local/gotrue/migrations` from `scripts/local-stack/fetch-binaries.sh`, or
`EARTH_GOTRUE_MIGRATIONS_DIR`, and skips loudly otherwise).

## Test files

Every `*.test.ts` under `src/` uses the harness above; each directory has a `fixtures.ts` that builds
its actors (Humans, groups, rooms, areas) through the RPCs. Root files cover the foundation, the
directories cover one tier each.

Root (`src/`):

- `enum-parity.test.ts` — the `public` enum types and `ENUM_REGISTRY` are the same list with
  identical ordered values, in both directions.
- `shim.test.ts` — roles, `auth.uid()/role()/email()/jwt()` per caller, GoTrue-style uniqueness,
  RLS on a probe table, re-applying the shim.
- `gotrue.test.ts` — GoTrue's real migrations before and after the shim + migrations.
- `helpers.test.ts` — `earth.sha256_hex`, `earth.random_token`, `earth.raise`, `earth.utc_now`,
  `earth.jwt_claims`, `earth.request_headers`, `earth.client_address`, `earth.is_anonymous_jwt`,
  `earth.is_service_role`, rate limits (windows, expiry, Human/Guest/Visitor budgets, pruning).
- `grants.test.ts` — schema privileges, default privileges for new tables/functions/sequences, RLS
  on internal tables, extension placement and execute, owner-only rate-limit functions.
- `harness.test.ts` — the harness itself (roles, claims, commit/rollback, rpc, expectError,
  cloning, isolation).

Directories:

- `admission/` — identity and social tier (01xx; DB_API §1–§2): the claim flow (spec §44–48), feature
  flags and app settings (0006) plus identity RPCs, groups (spec §22–24, §47), conversation
  membership RPCs (spec §25–26), the notifications primitive `earth.notify` (0190), the social graph
  RPCs (spec §20–21, mirroring `packages/domain/src/social/rules.ts`) and the RLS matrix over every
  admission table.
- `analytics/` — analytics and metrics (08xx; DB_API §8): the event whitelist equals `EVENT_NAMES`,
  `analytics_track` (identity from the credential, coordinates stripped, budgets),
  `rtc_diagnostic_record`, `metrics_compute_daily` over a synthetic day, and the service-only RLS
  matrix for `analytics_events`, `rtc_diagnostics`, `metrics_daily`.
- `authz/` — launch-blocker authorization audits (spec §114): the execute-privilege matrix over every
  `public` RPC, the authorization matrix over every `public` table (introspected, so an uncovered
  table fails), schema/column/publication lockdown (0002, 0170, 0320, realtime), and permission-fixture
  parity with `packages/permissions/fixtures/*.json` (DB_API §11).
- `geo/` — areas, places, context and location (05xx; DB_API §5): `area_resolve` and area/place RPCs
  (never storing coordinates), location sharing with precision degradation, blocks, expiry and the
  `LOCATION_SHARING_ENABLED` flag, and the RLS matrix over the geo tables.
- `integration/` — the server tier end to end (ARCHITECTURE §6): `packages/server` handlers run
  unchanged over harness-backed `ServerDeps` (`server-deps.ts`: every `rpc` is executed by `db.rpc`
  as the bearer's caller, mock verification provider, recording push sender, LiveKit dev keys) —
  `GET /api/feed` (ranked pages over `feed_candidates`, keyset cursor, visitor World), `GET /api/live`
  (Live Home ordering over `live_candidates`), `POST /api/internal/push/dispatch` (`notifications_unsent`
  → Expo messages → `notifications_mark_pushed`, presence-aware skipping), `POST /api/rooms/:id/token`
  (LiveKit claims exactly the `room_media_grant`), the verification routes (`human_pass_record_result`,
  `claim_complete`) and `POST /api/livekit/webhook` (signed bodies → `room_participant_sync`).
- `map-search/` — `map_objects` (SCREEN 20: Lives pinned to Place or area centroid only, degraded
  friend shares, moments, blocks, visitor World) and `search` (SCREEN 21: people ranking, blocked /
  hidden / pending never appear, groups for members only, 60/min).
- `messaging/` — conversations and messages (02xx; DB_API §2): message RPC invariants (idempotent
  sends, keyset pages, blocks, unread state, tombstones, reactions, 60/min), conversation summaries
  (SCREEN 08), message notifications (spec §86), system messages (`earth.system_message`, joins and
  leaves on the invite and claim paths), grants + realtime publication and replica identity, and the
  RLS matrix for `messages` / `message_reactions`.
- `notifications/` — notification RPCs (06xx; DB_API §6): `notifications_list` priority ordering and
  keyset pagination with the exact spec copy, read state, the push queue (`notifications_unsent`,
  `notifications_mark_pushed`, `notifications_prune`, presence-aware skipping), blocked actors never
  notifying, and the RLS matrix for `notifications` / `notification_cooldowns`.
- `posts/` — posts and feed (04xx; DB_API §4): post RPCs (creation, area context, replies with
  audience narrowing and reply policy, reactions, hides, soft delete, reply paging,
  `earth.can_view_post`), `feed_candidates` / `public_feed` candidate pools per scope, and the RLS
  matrix for the post tables.
- `rooms/` — rooms, Guests and Live (03xx; DB_API §3): lifecycle (start, join, leave, moderator
  transfer, grace-period end), visibility / consent / Live discovery (spec §58–60), Live
  notifications and dedupe (spec §86–87), Guests and room invites (SCREEN 17–19), `activeRoom`
  pointers on chats and groups (0350), and the RLS matrix over the room tables.
- `safety/` — safety (07xx; DB_API §7): reports (every target type, severity, audit, 20/h), Guest
  reports scoped to their own room, the reports RLS matrix, the rate-limit review (every mutating RPC
  is limited; the 0730 inventory matches the sources) and block overrides across every surface
  (spec §21, §56, §128).
- `seed/` — the development fixtures of `supabase/seed` applied twice onto a fresh database: the
  documented inventory, fixture Humans leaving every visitor surface in `production`, idempotency.
- `verify/` — adversarial verification of the spec §128 invariant clusters: identity (Guest is not
  Human, public identity is not Human identity, no silent second Human), rooms (Live is a Room
  state, consent gating, admission, grants) and social (member ≠ friend, friend ≠ follow, blocks
  override all discovery).
