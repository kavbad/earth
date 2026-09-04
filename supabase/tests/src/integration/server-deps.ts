/**
 * Test-only `ServerDeps` over the database harness (ARCHITECTURE §6, §15).
 *
 * The server tier's handlers run unchanged; every `supabase*.rpc(name, args)` they issue is
 * executed by `db.rpc` as the caller the bearer stands for. Bearers are opaque strings minted by
 * `tokens.for(roleSpec)`; the anon client runs as a Visitor, the admin client as the service, and
 * an unknown bearer answers like PostgREST does for a bad JWT (`PGRST301`). Postgres errors come
 * back in PostgREST's `{ code, message, details, hint }` shape so `rpcAs` maps them exactly as in
 * production.
 *
 * Everything else is a double: the mock verification provider of `@earth/auth`, a recording push
 * sender, the LiveKit dev key pair (`devkey` / `secret`), a memory logger and a clock that only
 * moves when a test moves it (`clock.now`). The clock starts at the real time because rows are
 * stamped by the database clock (`earth.utc_now()`), never by `deps.now()`.
 *
 * Workspace packages are imported by relative path, like `../domain.ts` does: this package declares
 * no dependency on `@earth/server`, `@earth/auth` or `@earth/observability`.
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'

import {
  MockHumanVerificationProvider,
  type MockHumanVerificationProviderOptions,
} from '../../../../packages/auth/src/verification/index'
import {
  createLogger,
  createMemorySink,
  type MemorySink,
} from '../../../../packages/observability/src/index'
import {
  CRON_SECRET_HEADER,
  type EarthResponse,
  type HumanVerificationProvider,
  type RpcArgs,
  type RpcError,
  type ServerDeps,
  type SupabaseRpcClient,
} from '../../../../packages/server/src/index'
import {
  createFakeAnalyticsSink,
  createFakePushSender,
  createFakeStorage,
  testServerEnv,
  type FakeAnalyticsSink,
  type FakePushSender,
  type FakeStorage,
} from '../../../../packages/server/src/test/fakes'
import type { RoleSpec, TestDb } from '../harness'

export { fakeRequest } from '../../../../packages/server/src/test/fakes'
export {
  createEarthServer,
  type EarthResponse,
  type EarthServer,
} from '../../../../packages/server/src/index'

/** LiveKit's development key pair (`livekit-server --dev`). */
export const TEST_LIVEKIT = {
  apiKey: 'devkey',
  apiSecret: 'secret',
  url: 'ws://localhost:7880',
} as const

export type ClientKind = 'admin' | 'anon' | `user:${string}`

/** One RPC the server issued, with who ran it and what the database answered. */
export interface RecordedRpc {
  readonly client: ClientKind
  readonly name: string
  readonly args: RpcArgs
  /** The harness caller the client resolved to; `null` for an unknown bearer. */
  readonly as: RoleSpec | null
  data: unknown
  error: RpcError | null
}

export interface BearerTokens {
  /** Registers a caller and returns the bearer the server should see for it. */
  for(as: RoleSpec): string
  roleOf(token: string): RoleSpec | undefined
}

export interface ServerTestDeps {
  readonly deps: ServerDeps
  readonly tokens: BearerTokens
  /** `deps.now()`; assign to move time. */
  readonly clock: { now: Date }
  readonly verification: MockHumanVerificationProvider
  readonly push: FakePushSender
  /** Records what `GET /api/media/:bucket/:key*` signs (no Storage service in the test stack). */
  readonly storage: FakeStorage
  readonly analytics: FakeAnalyticsSink
  readonly logs: MemorySink
  readonly calls: RecordedRpc[]
  callsTo(name: string): RecordedRpc[]
  /** `x-earth-cron-secret` for `/api/internal/*`. */
  cronHeaders(): Record<string, string>
}

export interface ServerTestDepsOptions {
  readonly now?: Date
  /** Mock provider tuning (`duplicateOfHumanId`, `delayMs`, ...); `appEnv` and `now` are fixed. */
  readonly mock?: Omit<MockHumanVerificationProviderOptions, 'appEnv' | 'now'>
  /** Replaces the mock provider. */
  readonly verification?: HumanVerificationProvider
}

/** PostgREST's error body for a Postgres error (`pg` calls the detail field `detail`). */
export function postgrestErrorOf(error: pg.DatabaseError): RpcError {
  return {
    message: error.message,
    code: error.code ?? null,
    details: error.detail ?? null,
    hint: error.hint ?? null,
  }
}

/** What PostgREST answers for a bearer it cannot verify. */
export const JWT_INVALID_ERROR: RpcError = {
  message: 'JWSError JWSInvalidSignature',
  code: 'PGRST301',
  details: null,
  hint: null,
}

function cleanArgs(args: RpcArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value
  }
  return out
}

function harnessClient(
  db: TestDb,
  kind: ClientKind,
  resolve: () => RoleSpec | undefined,
  calls: RecordedRpc[],
): SupabaseRpcClient {
  return {
    async rpc(name, args = {}) {
      const as = resolve()
      const record: RecordedRpc = {
        client: kind,
        name,
        args,
        as: as ?? null,
        data: null,
        error: null,
      }
      calls.push(record)
      if (as === undefined) {
        record.error = JWT_INVALID_ERROR
        return { data: null, error: JWT_INVALID_ERROR }
      }
      try {
        const data = (await db.rpc<unknown>(name, cleanArgs(args), as)) ?? null
        record.data = data
        return { data, error: null }
      } catch (cause) {
        if (cause instanceof pg.DatabaseError) {
          const error = postgrestErrorOf(cause)
          record.error = error
          return { data: null, error }
        }
        throw cause
      }
    },
  }
}

export function createServerTestDeps(
  db: TestDb,
  options: ServerTestDepsOptions = {},
): ServerTestDeps {
  const clock = { now: options.now ?? new Date() }
  const roles = new Map<string, RoleSpec>()
  const tokens: BearerTokens = {
    for(as) {
      const token = `test-bearer-${randomUUID()}`
      roles.set(token, as)
      return token
    },
    roleOf: (token) => roles.get(token),
  }
  const calls: RecordedRpc[] = []
  const push = createFakePushSender()
  const storage = createFakeStorage()
  const analytics = createFakeAnalyticsSink()
  const logs = createMemorySink()
  const mock = new MockHumanVerificationProvider({
    ...options.mock,
    appEnv: 'development',
    now: () => clock.now,
  })
  const env = testServerEnv({
    LIVEKIT_API_KEY: TEST_LIVEKIT.apiKey,
    LIVEKIT_API_SECRET: TEST_LIVEKIT.apiSecret,
    LIVEKIT_URL: TEST_LIVEKIT.url,
  })
  const deps: ServerDeps = {
    supabaseAdmin: harnessClient(db, 'admin', () => 'service', calls),
    supabaseAnon: harnessClient(db, 'anon', () => 'visitor', calls),
    supabaseForUser: (token) =>
      harnessClient(db, `user:${token}`, () => tokens.roleOf(token), calls),
    livekit: { ...TEST_LIVEKIT },
    verification: options.verification ?? mock,
    push: push.sender,
    analytics: analytics.sink,
    logger: createLogger({ sink: logs.sink, level: 'debug', now: () => clock.now }),
    now: () => clock.now,
    env,
    cronSecret: env.INTERNAL_CRON_SECRET,
    storage: storage.storage,
  }
  return {
    deps,
    tokens,
    clock,
    verification: mock,
    push,
    storage,
    analytics,
    logs,
    calls,
    callsTo: (name) => calls.filter((call) => call.name === name),
    cronHeaders: () => ({ [CRON_SECRET_HEADER]: env.INTERNAL_CRON_SECRET }),
  }
}

/** The `{ error: { code } }` body of an error response. */
export function errorCodeOf(response: EarthResponse): string | undefined {
  const body = response.body as { error?: { code?: unknown } } | undefined
  const code = body?.error?.code
  return typeof code === 'string' ? code : undefined
}
