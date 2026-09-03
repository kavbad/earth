# e2e — the twelve journeys

Playwright walks the web client the way a person does: the local stack behind it
(`scripts/local-stack`, ARCHITECTURE.md §15) and no mocking above the network. The journeys are
spec §116, one file each:

| File                           | Journey                                                               |
| ------------------------------ | --------------------------------------------------------------------- |
| `journeys/00-smoke.spec.ts`    | the web app and the gateway answer, Home renders                      |
| `journeys/00b-harness.spec.ts` | the harness itself: one Human claimed through the real claim UI       |
| `journeys/01…12-*.spec.ts`     | E2E 1–12 (Start Earth, Join group, Group chat, Video, Friend Live, …) |

## Running

```bash
pnpm e2e                          # everything: stack up, build + start apps/web, run, stack down
pnpm e2e -- journeys/03-group-chat.spec.ts   # one journey
pnpm --filter @earth/e2e test:headed         # watch it happen
pnpm --filter @earth/e2e report              # open the last HTML report
```

Root `pnpm test` includes this package, so it starts the stack too. For unit tests only, run
`pnpm turbo run test --filter='!@earth/e2e' --filter='!@earth/db-tests'` — that is CI's `check` job.

`pnpm e2e` owns the whole run:

1. `global-setup.ts` runs `bash scripts/local-stack/up.sh` — Postgres, PostgREST, GoTrue, LiveKit,
   Mailpit and the gateway on 54321, with `earth_local` recreated from the migrations and the
   seeds. `KEEP_DB` is never used: every journey makes its own people, and the seeded fixtures
   have to be exactly what `supabase/seed/README.md` says.
2. It then builds and starts `apps/web` on 3000 with `.local/stack.env` plus
   `HUMAN_VERIFICATION_PROVIDER=mock` and `APP_ENV=development`, and waits for
   `GET /api/health` (`serverTier: "ready"`) and for the gateway's `/auth/v1/health`.
3. `global-teardown.ts` stops the web app and runs `bash scripts/local-stack/down.sh`. The
   database is left behind on purpose, so a failure can still be inspected.

### Against a stack you already run

```bash
pnpm stack:up:web                 # or pnpm stack:up + pnpm dev:web
E2E_EXTERNAL_STACK=1 pnpm e2e     # start nothing, stop nothing, just wait for both to answer
```

That is also how CI runs it (`.github/workflows/ci.yml`, job `e2e`), which is why a failed CI run
uploads the stack logs next to the traces.

### Environment

| Variable                   | Meaning                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `E2E_EXTERNAL_STACK=1`     | the stack and the web app are already running; the harness leaves them alone  |
| `E2E_BASE_URL`             | where the web app is (default `http://localhost:3000`)                        |
| `NEXT_PUBLIC_SUPABASE_URL` | the gateway (default `http://localhost:54321`)                                |
| `EARTH_MAILPIT_URL`        | where one-time codes are read (default `http://127.0.0.1:8025`)               |
| `E2E_OTP_VIA_SCRIPT=1`     | read codes through `bash scripts/local-stack/otp.sh` instead of Mailpit's API |

Anything not exported falls back to `.local/stack.env`, which `up.sh` writes.

## Logs and artifacts

| Path                        | What                                                        |
| --------------------------- | ----------------------------------------------------------- |
| `.local/logs/e2e-web.log`   | the web app this harness builds and starts (build + server) |
| `.local/logs/<service>.log` | Postgres, PostgREST, GoTrue, LiveKit, Mailpit, gateway      |
| `e2e/test-results/`         | traces (`on-first-retry`) and failure screenshots           |
| `e2e/playwright-report/`    | the HTML report                                             |

## Writing a journey

Everything a journey needs is in `fixtures/`:

- **`stack.ts`** — `baseURL()`, `gatewayURL()`, `mailpitURL()`, `anonKey()`, and the waits.
- **`contexts.ts`** — `newPerson(browser)` and `newGuest(browser)`: one browser context per
  person, camera and microphone granted (Chromium runs with fake devices). Two people must never
  share a context — the session lives in cookies.
- **`people.ts`** — `createHumanViaClaim(page, { email, displayName, intent, groupName?,
inviteToken? })` walks the real claim UI end to end and returns `{ handle, conversationUrl }`
  with the page inside the group's conversation; `finishClaim(page, { email, displayName,
groupName? })` is the same claim from the credential on, for a person who entered somewhere other
  than the gate ("Join them" on a `/g/<token>` preview, spec §46); `signInExisting(page, email)`
  brings an existing Human back with an email code; `runId()`, `uniqueEmail()`, `uniqueName()` keep every run
  independent; `FIXTURE_EMAILS` and `FIXTURE_INVITE_TOKENS` are the read-only seed fixtures.
- **`otp.ts`** — `readLatestOtp(email)` polls Mailpit for up to 20 s.
- **`assertions.ts`** — `expectToast(page, message)`, `expectVisibleCopy(page, text)`.
- **`copy.ts`** — re-exports `copy` from `@earth/ui` and the web client's `webCopy` / `chatCopy`.

Rules that keep the suite honest:

- Role-based locators and the copy constants — never a CSS class, never a retyped sentence.
- No sleeping. Wait on UI state (`expect(...).toBeVisible()`, `waitForURL`), never on a clock.
- Every spec independent and deterministic, under 90 s, with its own people from `runId()`.
- When a journey fails because the product is wrong, fix the product. Never weaken the journey.
