# Earth V1 — production deployment

How to take this repository to a running production Earth: one hosted Supabase project, one
LiveKit Cloud project, one Vercel project for `apps/web` (which is both the web client and the
server tier, ARCHITECTURE §1), EAS builds for `apps/mobile`, and the provider accounts the
server tier talks to.

Read `docs/architecture/ARCHITECTURE.md` §14 (environment) and §6 (server routes) first —
this document is the operational half of those two sections. Every variable named here is
validated by `packages/config/src/env.ts` and documented in `.env.example`; a deploy that is
missing one fails loudly at boot (`GET /api/health` answers `503` and names the offending
variables — `apps/web/lib/server/health.ts`).

The order below is the order to do it in. Steps 1–3 are required for anything to work; 4–8 can
follow. **§11 "What is not automated" is part of the procedure, not an appendix** — several
things a launch needs are deliberately manual and are listed there.

---

## 0. Before you start

| You need                     | Why                                                                   |
| ---------------------------- | --------------------------------------------------------------------- |
| Supabase organization        | Postgres, Auth (GoTrue), Storage, Realtime                            |
| LiveKit Cloud project        | rooms media (spec §9); Earth mints its own tokens                     |
| Vercel team                  | `apps/web` — the member web client, guest rooms, and every `/api` route |
| The `earth.social` domain    | the canonical origin: share links, deep links, universal links (§112) |
| Apple Developer + Google Play | EAS builds, push credentials, universal/app links                     |
| Expo (EAS) account           | `eas build`, push delivery, `EXPO_ACCESS_TOKEN`                       |
| A Human verification vendor  | spec §15/§77; or run `manual_review` at launch (see §6)               |
| PostHog project (optional)   | analytics contract (spec §96–§97)                                     |
| Sentry project (optional)    | error monitoring                                                      |

Locally: Node 22 (`.nvmrc`), pnpm 10, and the Supabase CLI (`supabase --version`) for the
database step.

---

## 1. Supabase project

### 1.1 Create the project and link it

```bash
supabase login                              # or export SUPABASE_ACCESS_TOKEN
supabase link --project-ref <project-ref>
```

`supabase/config.toml` is the declaration of what the hosted project must look like. Its
`db.major_version = 17` is the Postgres major the CLI validates against (Supabase hosts 15 and
17; 16 is rejected outright and aborts every CLI command — `supabase/config.toml:20`). Create
the hosted project on Postgres 17.

### 1.2 Apply the migrations

```bash
supabase db push        # applies supabase/migrations in filename order
```

This is what `.github/workflows/deploy.yml` job `database` runs on every push to `main`
(`SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD`, `SUPABASE_PROJECT_REF`). Notes:

- The hosted ledger `supabase_migrations.schema_migrations` is keyed on the **numeric prefix**,
  so two files may never share one (`scripts/db/migrate-core.ts:132` `duplicateMigrationVersions`
  fails the local runner on a duplicate for exactly this reason).
- `supabase/tests/sql/supabase_shim.sql` is never pushed. It only exists to give a plain Postgres
  the `auth` and `storage` schemas that a hosted project already has.
- `supabase/seed/` is **development data** (spec §117). `supabase db push` does not apply it and
  `pnpm db:reset` refuses to seed when `APP_ENV=production` (`scripts/db/migrate-core.ts:90`).
  Never load it into production: `earth.setting('environment') = 'production'` additionally hides
  any `is_fixture` Human from visitors (`supabase/migrations/0410_posts_helpers.sql:105`).
- Extensions: `0001_extensions.sql` creates `postgis`, `pgcrypto`, `pg_trgm`. `pg_net` is used
  only where guarded (hosted push helpers).

### 1.3 Auth providers

Dashboard → Authentication → Providers / Settings, matching `supabase/config.toml [auth]`:

- **Anonymous sign-ins: enabled.** A Guest *is* an anonymous Supabase user
  (ARCHITECTURE §4; `guest_sessions.auth_user_id = auth.uid()`). With this off, no one can join a
  room from a link and E2E 7/8 are dead.
- **Email OTP: enabled**, 6 digits, 600 s expiry, confirmations off (`[auth.email]`).
- **Phone OTP: enabled** with an SMS provider configured in the dashboard (`[auth.sms]`).
- Site URL `https://earth.social`; additional redirect URLs `earth://` and
  `https://earth.social/**` (the mobile scheme is `earth`, `apps/mobile/app.config.ts:16`).
- Leave manual account linking off; Earth links credentials to Humans itself through
  `public.auth_identities`.

Copy from the dashboard: **Project URL**, **anon key**, **service-role key**, **JWT secret**.

### 1.4 Storage buckets

The three buckets and the five `storage.objects` policies are created by
`supabase/migrations/0997_storage_buckets.sql` when it runs against a project that has the
`storage` schema — that is, automatically, on the hosted project. Verify after the push:

```sql
select id, public, file_size_limit from storage.buckets order by id;
-- avatars (public, 5 MiB) | media (private, 100 MiB) | voice (private, 25 MiB)
select policyname from pg_policies where schemaname = 'storage' order by policyname;
-- earth_avatars_public_read, earth_owner_delete, earth_owner_update, earth_owner_write, earth_private_owner_read
```

Object keys are `<human_id>/<random>.<ext>`; ownership is the first path segment compared with
`earth.current_human_id()`. Private objects are never read directly by clients — every
`PostMediaDto` URL points at `GET /api/media/:bucket/:key*`, which authorizes the caller with
`media_access_grant` and then 302s to a short-lived service-signed URL
(`supabase/migrations/0972_media_signed_access.sql`, `packages/server/src/media/signed.ts`).

### 1.5 Realtime

Realtime delivers `messages`, `message_reactions`, `rooms`, `room_participants`,
`conversation_members` and `notifications`; the migrations add them to the `supabase_realtime`
publication idempotently (`0190_notifications.sql:143`, `0280_messages_realtime.sql`,
`0340_rooms_realtime.sql`). Confirm and enable Realtime in the dashboard:

```sql
select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by tablename;
```

RLS governs delivery — no extra Realtime authorization is configured. If Realtime is off or
unreachable, `@earth/realtime` degrades to its polling fallback (ARCHITECTURE §8); that is a
product feature, not a substitute for turning it on.

### 1.6 Settings the database reads (`public.app_settings`)

`0006_flags_settings.sql:86` seeds development defaults. **Run this on production** (SQL editor
or `psql`), because two of the four are wrong for production out of the box:

```sql
update public.app_settings set value = 'production',                 updated_at = now() where key = 'environment';
update public.app_settings set value = 'https://earth.social',       updated_at = now() where key = 'web_origin';
update public.app_settings set value = 'https://<project-ref>.supabase.co/storage/v1/object/public',
                                                                     updated_at = now() where key = 'public_storage_base_url';
update public.app_settings set value = '120',                        updated_at = now() where key = 'room_grace_seconds';
```

What each one does:

| key                       | read by                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `environment`             | hides fixture Humans from visitors and public surfaces (`0410_posts_helpers.sql:105`, `0430`, `0590_map.sql:135`, `0900_search.sql:50`, `0973_feed_presence.sql:54`) |
| `web_origin`              | the origin in every share link and media URL (`0185_rpcs_groups.sql:587` `/g/<token>`, `0330_rooms_rpcs.sql:1026` `/live/<token>`, `0410_posts_helpers.sql:200` `/api/media/…`) |
| `public_storage_base_url` | public avatar URLs; empty leaves `avatarUrl` null (`0160_helpers.sql:158`)                        |
| `room_grace_seconds`      | how long a room with no active Humans survives before `rooms_sweep()` ends it (`0330_rooms_rpcs.sql:1458`) |

`web_origin` must equal `NEXT_PUBLIC_WEB_ORIGIN` (§3) — the database builds the links, the app
serves them.

### 1.7 Feature flags — launch defaults

`0006_flags_settings.sql:73` seeds the spec §118 list, and the launch defaults are already the
production ones:

| flag                             | default   |
| -------------------------------- | --------- |
| `GROUP_ANCHORED_CLAIM_REQUIRED`  | **true**  |
| `PUBLIC_WORLD_ENABLED`           | **true**  |
| `PUBLIC_LIVE_ENABLED`            | **true**  |
| `NEIGHBORHOOD_ENABLED`           | **true**  |
| `CITY_ENABLED`                   | **true**  |
| `WORLD_ENABLED`                  | **true**  |
| `GUEST_ROOMS_ENABLED`            | **true**  |
| `FRIENDS_LIVE_EXPANSION_ENABLED` | **true**  |
| `WORLD_LIVE_EXPANSION_ENABLED`   | **true**  |
| `LOCATION_SHARING_ENABLED`       | **true**  |
| `MAFIA_ACTIVITY_ENABLED`         | **false** |

Flip one at runtime without a deploy:

```sql
update public.feature_flags set enabled = false, updated_at = now() where key = 'WORLD_LIVE_EXPANSION_ENABLED';
```

Clients read them through `me_get()` / `earth.flags_json()`; SQL reads them through
`earth.flag(key)`. A missing row is a disabled flag. `feature_flags` and `app_settings` are
readable by everyone and writable only by the service role (`0006_flags_settings.sql:27`).

### 1.8 Database roles and backups

Nothing to grant by hand: every table is `revoke`d and granted explicitly by the migrations
(ARCHITECTURE §5), and `supabase/tests/src/verify/grants.test.ts` is the assertion that this holds.
Turn on point-in-time recovery in the dashboard before the first real Human claims an identity.

---

## 2. LiveKit Cloud

1. Create a project; note the **websocket URL** (`wss://<project>.livekit.cloud`), **API key**
   and **API secret**.
2. Earth mints its own access tokens: `POST /api/rooms/:id/token` calls `room_media_grant` as the
   caller and derives every claim from that grant, never from client input
   (`packages/server/src/rooms/token.ts`; ARCHITECTURE §10). Token TTL is 2 hours, one token per
   join. No LiveKit-side room configuration is required.
3. Add a webhook: **URL `https://earth.social/api/livekit/webhook`**, signed with the same API
   key/secret. The handler verifies the signature with the SDK's `WebhookReceiver` and reconciles
   `room_participants` through the service RPC `room_participant_sync`
   (`packages/server/src/rooms/webhook.ts`). It consumes `participant_joined`,
   `participant_left` and `room_finished`; everything else is ignored, and a verified event
   always answers 200 so LiveKit does not retry.
4. LiveKit is a hint, never the source of truth: if the webhook is misconfigured, rooms still
   work and `rooms_sweep()` reconciles what a lost event would have done — but participant state
   will lag, so do not skip it.

---

## 3. Vercel (`apps/web` — web client **and** server tier)

### 3.1 Project

Import the repository; set **Root Directory** to `apps/web` and framework Next.js. The build
command is the default (`next build`); pnpm workspaces resolve from the repository root, so keep
"Include files outside the root directory" enabled. Node 22 (`.nvmrc`).

`.github/workflows/deploy.yml` job `web` does the same thing from CI with
`vercel pull / build --prod / deploy --prebuilt --prod` and the secrets `VERCEL_TOKEN`,
`VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`.

### 3.2 Environment variables

Set these in the Vercel project (Production scope). The names and meanings are exactly
`.env.example`; `packages/config/src/env.ts` validates them and refuses the localhost defaults
outside `APP_ENV=development`.

Public (inlined into the browser bundle — no secrets):

```
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
NEXT_PUBLIC_API_BASE_URL=https://earth.social
NEXT_PUBLIC_LIVEKIT_URL=wss://<project>.livekit.cloud
NEXT_PUBLIC_MAP_STYLE_URL=<MapLibre style JSON URL>
NEXT_PUBLIC_APP_ENV=production
NEXT_PUBLIC_WEB_ORIGIN=https://earth.social
NEXT_PUBLIC_POSTHOG_KEY=<optional>
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
NEXT_PUBLIC_SENTRY_DSN=<optional; see §8>
```

Server (secret — never `NEXT_PUBLIC_`):

```
APP_ENV=production
SUPABASE_SERVICE_ROLE_KEY=<service role key>
SUPABASE_JWT_SECRET=<JWT secret>
LIVEKIT_API_KEY=<key>
LIVEKIT_API_SECRET=<secret>
LIVEKIT_URL=wss://<project>.livekit.cloud
HUMAN_VERIFICATION_PROVIDER=vendor|manual_review     # `mock` is refused when APP_ENV=production
HUMAN_VERIFICATION_VENDOR_URL=<required for vendor>
HUMAN_VERIFICATION_VENDOR_KEY=<required for vendor>
HUMAN_VERIFICATION_WEBHOOK_SECRET=<required for vendor>
EXPO_ACCESS_TOKEN=<Expo access token; empty disables push dispatch>
INTERNAL_CRON_SECRET=<random, ≥16 chars>
POSTHOG_SERVER_KEY=<optional>
SENTRY_DSN=<optional>
ROOM_GRACE_SECONDS=120
```

Deploy-time only, for the association files (§4):

```
APPLE_TEAM_ID=<10-char team id>
IOS_BUNDLE_ID=social.earth.app
ANDROID_PACKAGE_NAME=social.earth.app
ANDROID_SHA256_CERT_FINGERPRINTS=<colon-separated sha256>[,<second>]
```

`NEXT_PUBLIC_APP_ENV` and `APP_ENV` must agree — the server refuses a deployment that is
"production" for its clients and "development" for its verification rules
(`packages/config/src/env.ts:20`).

### 3.3 Domain

Add `earth.social` (and `www` redirecting to it) to the Vercel project. It must be the same
origin as `NEXT_PUBLIC_WEB_ORIGIN` and `app_settings.web_origin`, because links minted by the
database (`/g/<token>`, `/live/<token>`, `/@handle`, `/p/<id>`, `/api/media/…`) are absolute.

### 3.4 Scheduled work (crons)

`apps/web/vercel.json` declares three schedules:

| path                          | schedule      | what it does                                                   |
| ----------------------------- | ------------- | -------------------------------------------------------------- |
| `/api/internal/push/dispatch` | `* * * * *`   | sends unsent notifications through Expo push, marks `push_sent_at` |
| `/api/internal/rooms/sweep`   | `* * * * *`   | `rooms_sweep()`: grace-period room ends, guest expiry, location-share expiry |
| `/api/internal/metrics/daily` | `10 2 * * *`  | `metrics_compute_daily(date)`                                   |

**These three routes are `POST` and authenticate with the header `x-earth-cron-secret`**
(`packages/server/src/router.ts:112`, `packages/server/src/cron.ts:11`), while Vercel Cron issues
`GET` with its own `Authorization: Bearer $CRON_SECRET`. The declaration alone therefore does not
drive them — see §11, item 1, for the two supported ways to schedule them. Whatever calls them
must send:

```bash
curl -fsS -X POST https://earth.social/api/internal/rooms/sweep \
  -H "x-earth-cron-secret: $INTERNAL_CRON_SECRET"
```

Sweeps are the reason a Live ends when everyone leaves and a location share stops being visible
when it expires; push dispatch is the reason a notification reaches a phone. Neither is optional.

### 3.5 First smoke test

```bash
curl -fsS https://earth.social/api/health | jq
# { "ok": true, "service": "earth-web", "serverTier": "ready", ... }
```

A `503` here lists the environment variables that failed validation.

---

## 4. Universal links (`/.well-known`)

Spec §112 requires `https://earth.social/g/…`, `/live/…`, `/@handle` and `/p/<id>` to open the
app. The two association documents live in `apps/web/public/.well-known/` and are **committed with
placeholders** (`APPLE_TEAM_ID`, `ANDROID_SHA256_CERT_FINGERPRINT_00:00:…`). Rewrite them from
the environment before the production build:

```bash
APPLE_TEAM_ID=ABCDE12345 \
IOS_BUNDLE_ID=social.earth.app \
ANDROID_PACKAGE_NAME=social.earth.app \
ANDROID_SHA256_CERT_FINGERPRINTS="AA:BB:…" \
pnpm exec tsx apps/web/lib/deeplinks/generate-well-known.ts
```

The generator writes both files and prints `(placeholders)` for any it could not fill
(`apps/web/lib/deeplinks/generate-well-known.ts`; the shapes and the path list come from
`apps/web/lib/deeplinks/well-known.ts`, whose `hasPlaceholders()` is the check a release gate
should run). Next serves the extensionless Apple file as `application/json`
(`apps/web/next.config.ts:32`). **This step is not wired into any build or deploy script** — see
§11, item 2.

Verify after deploy:

```bash
curl -fsS https://earth.social/.well-known/apple-app-site-association | jq .applinks.details[0].appIDs
curl -fsS https://earth.social/.well-known/assetlinks.json | jq '.[0].target.sha256_cert_fingerprints'
```

---

## 5. EAS (`apps/mobile`)

### 5.1 Project identity

`apps/mobile/app.config.ts:8` carries `EAS_PROJECT_ID = '00000000-0000-0000-0000-000000000000'`,
a placeholder. Replace it with the real project id (`eas init` prints it) before the first build;
`extra.eas.projectId` is the only project identity the app config has, and EAS builds and push
receipts key on it.

Fixed identity, already set: name `Earth`, slug `earth`, scheme `earth`, bundle id / package
`social.earth.app`, iOS `associatedDomains: ['applinks:earth.social']`, Android `intentFilters`
with `autoVerify` for `/g/`, `/live/`, `/p/`, `/@`, background modes `audio` + `voip`, and the
`expo-camera` / `expo-location` / `expo-notifications` / `expo-image-picker` /
`@livekit/react-native-expo-plugin` / `expo-build-properties` (minSdk 24) plugins.

### 5.2 Profiles

`apps/mobile/eas.json` has three build profiles — `development` (dev client, internal),
`preview` (internal), `production` (`autoIncrement`, channel `production`) — and a
`submit.production` block to fill in with your App Store Connect / Play Console identifiers.
Each profile sets only `EXPO_PUBLIC_APP_ENV`; **every other `EXPO_PUBLIC_*` variable must be
supplied**, either by linking an EAS environment to the profile
(`"environment": "production"` plus variables created with `eas env:create`) or by adding them to
the profile's `env` block:

```
EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_ANON_KEY, EXPO_PUBLIC_API_BASE_URL,
EXPO_PUBLIC_LIVEKIT_URL, EXPO_PUBLIC_MAP_STYLE_URL, EXPO_PUBLIC_WEB_ORIGIN,
EXPO_PUBLIC_POSTHOG_KEY, EXPO_PUBLIC_POSTHOG_HOST, EXPO_PUBLIC_SENTRY_DSN
```

They mirror the `NEXT_PUBLIC_*` values of §3.2 (same project, same LiveKit, same origin). A
build without them ships a client that cannot reach Supabase.

### 5.3 Credentials

```bash
cd apps/mobile
eas login
eas init                 # writes the project id — put it in app.config.ts
eas credentials          # iOS: distribution cert + provisioning profile, APNs key
                         # Android: upload keystore (its SHA-256 goes into assetlinks.json, §4)
eas build --profile production --platform all
eas submit --profile production --platform all
```

- **Associated domains**: iOS needs the *Associated Domains* capability on the App ID; EAS adds it
  from `ios.associatedDomains`, but the App ID in the Apple Developer portal must have it enabled.
- **Android App Links**: the `sha256_cert_fingerprints` in `/.well-known/assetlinks.json` must be
  the fingerprint of the key that actually signs the uploaded artifact — with Play App Signing
  that is the **app signing key** Google shows in the Play Console, not your upload key.
- **Push credentials**: iOS needs an APNs key uploaded to Expo (`eas credentials` → push key);
  Android needs FCM v1 credentials — a Firebase project, `google-services.json` referenced from
  `android.googleServicesFile`, and the service-account JSON uploaded to Expo. Neither the Firebase
  file nor that config key exists in this repository yet (§11, item 4). The server side is done:
  `push_tokens` rows and `POST /api/internal/push/dispatch` with `EXPO_ACCESS_TOKEN`.

CI: `.github/workflows/deploy.yml` job `mobile` runs
`eas build --non-interactive --profile production --platform all --no-wait` with `EXPO_TOKEN`,
only when the workflow is dispatched with `mobile_build`.

---

## 6. Human verification provider (spec §15, §77)

`HUMAN_VERIFICATION_PROVIDER` selects the adapter (`packages/auth/src/verification/`):

- `mock` — development only. **Refused when `APP_ENV=production`** by both the schema and the
  provider's constructor (`packages/auth/src/verification/mock.ts:72`).
- `manual_review` — no vendor. A Human Pass is recorded as pending review and a human being
  decides. This is a legitimate launch posture for a small, invite-shaped rollout; it needs an
  operator watching `identity_reviews` and calling the review RPCs.
- `vendor` — the generic hosted-liveness adapter. Requires `HUMAN_VERIFICATION_VENDOR_URL`,
  `HUMAN_VERIFICATION_VENDOR_KEY` and `HUMAN_VERIFICATION_WEBHOOK_SECRET`.

The vendor wire contract is fixed and vendor-agnostic
(`packages/auth/src/verification/vendor.ts:1`): any vendor is mapped onto it **by configuration,
never by editing the app**.

- `POST {baseUrl}/sessions`, `Authorization: Bearer <apiKey>`, body
  `{ subject_id, reference_id, locale, platform, return_url? }` → `{ id, url, expires_at }`.
  `subject_id` is the Human id (the vendor's dedupe key), `reference_id` the Human Pass id.
- `GET {baseUrl}/sessions/{id}` → `{ id, status, risk?, duplicate_of?, … }`.
- Webhook → **`https://earth.social/api/claim/verification/webhook`**: raw JSON body signed
  HMAC-SHA256 with `HUMAN_VERIFICATION_WEBHOOK_SECRET`; the signature header may be a bare hex
  digest, `sha256=<hex>` or `t=…,v1=<hex>`. Checked in constant time before the body is parsed;
  recording is idempotent, so replays are harmless.

If your vendor's shape differs, put a translating proxy in front of it and point
`HUMAN_VERIFICATION_VENDOR_URL` at the proxy. Raw vendor payloads are kept whole under
`metadata.vendor` in `private` (spec §19, §78) and never leave the server tier.

Result recording always goes through the service RPC `human_pass_record_result`; the client never
sees more than a status.

---

## 7. PostHog (analytics, spec §96–§97)

- Browser/app: `NEXT_PUBLIC_POSTHOG_KEY` + `NEXT_PUBLIC_POSTHOG_HOST` (and the `EXPO_PUBLIC_`
  twins). Empty selects the noop adapter — analytics is optional and the product does not change.
- Server: `POSTHOG_SERVER_KEY` (`posthog-node`), used by the server tier and by
  `POST /api/analytics/ingest` (the first-party sink, rate limited).
- The event contract is a typed union in `packages/analytics`; identity properties are attached
  per spec §96. No PII beyond the Human id is sent.

## 8. Sentry (error monitoring)

- Server tier: set `SENTRY_DSN`. `apps/web/lib/server/wiring.ts:94` initialises `@sentry/nextjs`
  and forwards error-level logs to it; unset selects the no-op monitor. Set
  `VERCEL_GIT_COMMIT_SHA` (Vercel does this automatically) to get releases.
- Mobile: `EXPO_PUBLIC_SENTRY_DSN` with `@sentry/react-native`.
- **Browser: `NEXT_PUBLIC_SENTRY_DSN` is validated and inlined but nothing initialises a browser
  Sentry client yet** (§11, item 5). Leaving it empty is honest; setting it does not enable
  anything today.

---

## 9. Deploy order and rollback

1. `supabase db push` (schema first — the app must never run ahead of its schema).
2. Vercel production deploy.
3. EAS build/submit when the mobile client changed.

`.github/workflows/deploy.yml` encodes exactly that dependency (`web` needs `database`). Rollback:
re-deploy the previous Vercel build (instant) — **migrations are not reversible**; every fix is a
new forward migration (ARCHITECTURE §5, "never edit a migration that another agent owns").

## 10. Post-deploy verification

```bash
curl -fsS https://earth.social/api/health                       # serverTier: ready
curl -fsS "https://earth.social/api/feed?scope=world" | jq '.cards | length'   # visitors may read World
curl -fsS -o /dev/null -w '%{http_code}\n' "https://earth.social/api/feed?scope=friends"  # 401 without a session
curl -fsS https://earth.social/.well-known/assetlinks.json      # no placeholders
```

In the product: claim one Human end to end (real OTP, real verification provider), start a group,
send a message, start a room and confirm a second device sees it, open the room up to Friends,
open the share link in a browser as a Guest, and confirm one push arrives on a real device. The
Playwright journeys (`e2e/`) prove all of this against the local stack, not against production.

---

## 11. What is not automated

Everything here is a deliberate gap, not an oversight. A launch has to close each one by hand.

1. **The cron schedules do not fire the routes as declared.** `apps/web/vercel.json` lists the
   three internal routes, but Vercel Cron sends `GET` with `Authorization: Bearer $CRON_SECRET`
   while the routes are `POST` + `x-earth-cron-secret` (`packages/server/src/router.ts:112`,
   `packages/server/src/cron.ts:11`). Until that is reconciled, schedule them from something that
   can POST with a custom header — a GitHub Actions `schedule` job, Supabase `pg_cron` +
   `pg_net`, or any external scheduler — or add `GET` aliases that accept Vercel's bearer token.
   Without one of these: rooms never end on their own, guest sessions and location shares never
   expire, and no push is ever delivered.
2. **`/.well-known` association files are committed with placeholders** and the generator that
   fills them (`apps/web/lib/deeplinks/generate-well-known.ts`) is referenced by no build or
   deploy step. Run it (§4) and commit or deploy the result; otherwise universal links silently
   fall back to the web page.
3. **`EAS_PROJECT_ID` is the all-zero placeholder** (`apps/mobile/app.config.ts:8`) and the
   `production` EAS profile supplies only `EXPO_PUBLIC_APP_ENV` — no EAS environment is linked,
   so a production build has no Supabase URL, no anon key, no LiveKit URL (§5.1, §5.2).
4. **Android push and Android maps have no configuration in the repo.** There is no
   `android.googleServicesFile` / `google-services.json` (FCM v1 is required for Expo push on
   Android, spec §12) and no Google Maps API key for `react-native-maps`, whose default provider
   on Android is Google Maps — the map will render blank on Android until a key is added.
5. **No browser Sentry client.** `NEXT_PUBLIC_SENTRY_DSN` is read into the public env
   (`apps/web/lib/supabase/public-env.ts:35`) but no `Sentry.init` runs in the browser; only the
   server tier reports.
6. **`supabase/config.toml` describes local values.** `site_url` is `http://localhost:3000` and
   the ports are the CLI's. Production Auth settings (§1.3) and the production site URL are set in
   the Supabase dashboard; nothing in this repository asserts that the hosted project matches.
7. **Age gating is not encoded** (spec §84). There is no birthdate, no age field and no
   minor-handling policy anywhere in the schema or the clients; a launch must decide 18+ and
   enforce it outside this codebase, or add the gating first.
8. **Reporting a specific Guest from a room** is not reachable in either client. `reports`
   accepts `target_type = 'guest'` (`supabase/migrations/0700_reports.sql:26`) and both
   `SafetyMenu` components can build that target, but no room screen mounts them: the room's
   report control reports the *room*. Remove and block-from-room for a Guest do work
   (`apps/web/components/rooms/ParticipantsSheet.tsx:87`, `:95` and the mobile twin).
9. **App Store / Play compliance** — privacy nutrition labels, data-safety form, age rating,
   camera/microphone/location purpose strings beyond the ones in `app.config.ts`, review notes for
   a Guest-joinable video product — is entirely manual.
10. **Operational monitoring** — uptime checks, LiveKit usage alarms, Supabase disk/connection
    alarms, a dashboard over `metrics_compute_daily` output — is not set up. The metrics are
    computed; nothing reads them.
11. **Secrets rotation.** `SUPABASE_JWT_SECRET`, `LIVEKIT_API_SECRET`, `INTERNAL_CRON_SECRET` and
    the vendor keys have no rotation procedure. Rotating the JWT secret invalidates every live
    session, including Guests in rooms.
