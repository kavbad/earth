# Seed fixtures

Development-only data, applied by `pnpm db:reset` (and `pnpm db:seed`) as `supabase/seed/*.sql`
in lexical order: `010_fixtures.sql` (fixture Humans and everything around them),
`020_dev_settings.sql` (`app_settings.environment = 'development'` and `web_origin` pointing at the
local web app, so the links a development database mints open it), `areas.sql` (extra areas and
places outside San Francisco). Seeds are never applied when `APP_ENV=production`, are never
recorded in `public.earth_migrations`, and every file refuses to run when
`app_settings.environment = 'production'`.

Rules (spec §117, DB_API §10, ARCHITECTURE.md §15):

- Fixture Humans carry `humans.is_fixture = true`; fixture areas and places carry `is_fixture = true`.
  When `app_settings.environment = 'production'` the visitor-facing surfaces (`feed_candidates`,
  `public_feed`, `search`, `map_objects`, `earth.identity_visible_to` → `profile_get` and the
  `public_identities` policy) exclude fixtures, so production can never display a fake Human even if
  a row slipped in. Launch content in production comes from a real seeded cohort, never from these
  files.
- Seed files are idempotent (re-runnable): `010_fixtures.sql` deletes and recreates the
  fixture-owned rows on every run (Human ids are fixed; `auth.users` rows are upserted by id so a
  GoTrue session as a fixture survives a re-seed). Everything a client could do goes through the
  public RPCs under caller impersonation (`request.jwt.claims` + the frozen `earth.now` clock), so
  the same invariants hold as for real traffic. Feature flags are never touched.
- Tests: `supabase/tests/src/seed/seed.test.ts` applies the seeds onto a fresh migrated scratch
  database twice and asserts the inventory below, the production filter and the invite previews.

## Fixture Humans

All active, `human_pass_status = 'verified'` through the `mock` provider, public profiles, home city
San Francisco. Ids are fixed (`a…` credentials, `b…` Humans) so tooling can address them.

| Human  | Email                         | `auth.users.id`                        | `humans.id`                            | Neighborhood | Groups                        |
| ------ | ----------------------------- | -------------------------------------- | -------------------------------------- | ------------ | ----------------------------- |
| Xavier | `xavier@fixtures.earth.local` | `a0000000-0000-4000-8000-000000000001` | `b0000000-0000-4000-8000-000000000001` | North Beach  | Weekend Crew (owner)          |
| Maya   | `maya@fixtures.earth.local`   | `a0000000-0000-4000-8000-000000000002` | `b0000000-0000-4000-8000-000000000002` | Mission      | Weekend Crew, College (owner) |
| Kavon  | `kavon@fixtures.earth.local`  | `a0000000-0000-4000-8000-000000000003` | `b0000000-0000-4000-8000-000000000003` | North Beach  | Weekend Crew                  |
| Sarah  | `sarah@fixtures.earth.local`  | `a0000000-0000-4000-8000-000000000004` | `b0000000-0000-4000-8000-000000000004` | Mission      | Weekend Crew                  |
| Ben    | `ben@fixtures.earth.local`    | `a0000000-0000-4000-8000-000000000005` | `b0000000-0000-4000-8000-000000000005` | Mission      | College                       |
| Chris  | `chris@fixtures.earth.local`  | `a0000000-0000-4000-8000-000000000006` | `b0000000-0000-4000-8000-000000000006` | North Beach  | College                       |
| Alex   | `alex@fixtures.earth.local`   | `a0000000-0000-4000-8000-000000000007` | `b0000000-0000-4000-8000-000000000007` | North Beach  | —                             |
| Sam    | `sam@fixtures.earth.local`    | `a0000000-0000-4000-8000-000000000008` | `b0000000-0000-4000-8000-000000000008` | Mission      | College                       |

Handles are the lowercase first names (`xavier`, `maya`, …). One anonymous credential
(`a0000000-0000-4000-8000-0000000000a1`) is the Guest "Jules" of the standalone Live. No avatars:
the local stack has no Storage, so `avatarUrl` is `null` everywhere.

## Inventory

| Object             | Rows                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Friendships        | Xavier–Maya, Xavier–Kavon, Kavon–Maya, Maya–Sarah, Ben–Chris, Sarah–Ben (12 `friend` rows, written through `friend_request_send` both ways; the resulting `friend_request` / `friend_accepted` notifications are three weeks old and read)                                                                                                                                           |
| Follows            | Alex → Xavier, Sam → Maya (unread `follow` notifications, yesterday)                                                                                                                                                                                                                                                                                                                 |
| Pending request    | Alex → Kavon (`friend_pending`; Kavon has an unread `friend_request` notification from five hours ago)                                                                                                                                                                                                                                                                               |
| Groups             | **Weekend Crew** (Xavier owner; Maya, Kavon, Sarah — 31 days old) and **College** (Maya owner; Ben, Chris, Sam — 46 days old). Members joined through `group_invite_join` with the tokens below, so each invite has `use_count = 3`.                                                                                                                                                 |
| Group invites      | One active, non-expiring invite per group with a known plaintext token (see below)                                                                                                                                                                                                                                                                                                   |
| Conversations      | Weekend Crew: 36 messages (32 chat + "Maya/Kavon/Sarah joined" + "Xavier started a video"), College: 34 messages (31 chat + 3 joins), Xavier ↔ Maya direct: 9 messages; all spread over the last three days (joins at group age)                                                                                                                                                     |
| Read state         | Everyone caught up except Sarah (3 unread in Weekend Crew), Chris (4 unread in College) and Xavier (1 unread in the DM); five message reactions                                                                                                                                                                                                                                      |
| Posts (21)         | World: one per fixture (8). City (San Francisco): Xavier, Sarah, Ben (3). Neighborhood: Xavier and Kavon (North Beach), Maya (a Dolores Park moment) and Sarah (Mission) (4). Friends: Maya, Kavon, Chris (3). Reply thread on Xavier's sunrise post: Maya, Kavon, and Xavier replying to Maya (3). Sixteen reactions.                                                               |
| Lives (both ended) | **Weekend Crew** "Saturday plans": started 3 h ago by Xavier (camera), Maya joined on camera, Kavon on audio; opened up to `friends` (applied once Kavon consented); ended by Xavier 2 h ago. **Standalone** "Coffee walk in the Mission": started 26 h ago by Sarah, Ben on audio, Guest "Jules" joined through a room invite link (`guest_sessions` row, expired); ended 25 h ago. |
| Places (fixture)   | Caffe Trieste, Coit Tower (North Beach), Mission Dolores, Clarion Alley (Mission); plus `areas.sql`'s Oakland / New York / Los Angeles neighborhoods and places                                                                                                                                                                                                                      |
| Presence, context  | `human_presence` rows with recent activity; `human_context` = current neighborhood / San Francisco / home San Francisco (set through `context_set`)                                                                                                                                                                                                                                  |
| Settings           | `environment = development` (020); every other `app_settings` row and every feature flag is left as the migrations set it                                                                                                                                                                                                                                                            |

## Known invite tokens

| Group        | Token                    | Link (local web)                                 |
| ------------ | ------------------------ | ------------------------------------------------ |
| Weekend Crew | `weekend-crew-dev-token` | `http://localhost:3000/g/weekend-crew-dev-token` |
| College      | `college-dev-token`      | `http://localhost:3000/g/college-dev-token`      |

Only `earth.sha256_hex(token)` is stored (`group_invites.token_hash`). `group_invite_preview(token)`
works for every caller; a Human joins with `group_invite_join(token)`; a Visitor claims with
`claim_start('join_group', null, token)`. The tokens never expire and have no use limit, so a
re-seed is the only thing that resets `use_count`.

## Signing in as a fixture locally

GoTrue in the local stack (`pnpm stack:up`) sends email one-time codes through Mailpit
(SMTP 1025, UI/API `http://localhost:8025`). Fixture addresses are `<name>@fixtures.earth.local`
and the credentials are confirmed, so an OTP sign-in resumes the existing Human (no claim flow).

1. Request a code (through the gateway on 54321, `apikey` = the anon key from `.local/stack.env`):

   ```sh
   set -a && source .local/stack.env && set +a
   curl -s -X POST "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/otp" \
     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
     -d '{"email":"xavier@fixtures.earth.local"}'
   ```

   or type the address into the web / mobile sign-in screen.

2. Read the code from Mailpit: `pnpm stack:otp xavier@fixtures.earth.local` (or open
   `http://localhost:8025`).

3. Verify it (the apps do this for you when you enter the code):

   ```sh
   curl -s -X POST "$NEXT_PUBLIC_SUPABASE_URL/auth/v1/verify" \
     -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" -H "Content-Type: application/json" \
     -d '{"type":"email","email":"xavier@fixtures.earth.local","token":"<code>"}'
   ```

   The session's `sub` is the fixed `auth.users.id` above, so `me_get()` answers with Xavier's
   Human. A fixture stays signed in across `pnpm db:seed` (credentials are upserted, not
   recreated); `pnpm db:reset` drops the database and therefore every session.

To rehearse the production behavior against the fixtures, run
`update public.app_settings set value = 'production' where key = 'environment'` and reload World as
a Visitor (the fixture posts, profiles and places disappear); `pnpm db:seed` puts the setting back.
