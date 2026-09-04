/**
 * Test doubles for the server tier: an in-memory Supabase RPC client with per-RPC handlers, a
 * recording push sender, a memory logger, a fixed clock and a scriptable verification provider.
 * Never exported from the package.
 */
import type { AnalyticsEnvelope, AnalyticsSinkContext } from '@earth/analytics'
import { type ServerEnv, ServerEnvSchema } from '@earth/config'
import type { HumanId } from '@earth/domain'
import { type MemorySink, createLogger, createMemorySink } from '@earth/observability'

import type {
  PushMessage,
  PushTicket,
  RpcArgs,
  RpcError,
  ServerDeps,
  SignedUrlResult,
  StorageLike,
  SupabaseRpcClient,
} from '../deps'
import type { EarthRequest } from '../http'
import type {
  HumanVerificationProvider,
  StartVerificationInput,
  VerificationResult,
  VerificationSession,
  VerificationWebhookEvent,
} from '../verification/provider-types'

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface FakeRequestInit {
  readonly method?: string
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
  /** Objects are JSON-encoded; strings are sent verbatim. */
  readonly body?: unknown
  readonly bearer?: string
}

export function fakeRequest(init: FakeRequestInit): EarthRequest {
  const headers = new Headers(init.headers ?? {})
  if (init.bearer !== undefined) headers.set('authorization', `Bearer ${init.bearer}`)
  const text =
    init.body === undefined
      ? ''
      : typeof init.body === 'string'
        ? init.body
        : JSON.stringify(init.body)
  if (init.body !== undefined && typeof init.body !== 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return {
    method: init.method ?? 'GET',
    url: init.url,
    headers,
    text: async () => text,
    json: async () => (text.trim() === '' ? undefined : (JSON.parse(text) as unknown)),
  }
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

export type FakeClientKind = 'admin' | 'anon' | `user:${string}`

export interface RpcCall {
  readonly client: FakeClientKind
  readonly name: string
  readonly args: RpcArgs
}

/** Thrown by a handler to make the fake return `{ data: null, error }` (a Postgres error). */
export class FakeRpcFailure {
  constructor(readonly error: RpcError) {}
}

/** `raise exception using errcode = 'P0001', message = '<code>'` as PostgREST reports it. */
export function rpcFailure(code: string, details?: string): FakeRpcFailure {
  return new FakeRpcFailure({ message: code, code: 'P0001', details: details ?? null, hint: null })
}

export type RpcHandler = (args: RpcArgs, call: RpcCall) => unknown

export interface FakeSupabase {
  readonly admin: SupabaseRpcClient
  readonly anon: SupabaseRpcClient
  forUser(token: string): SupabaseRpcClient
  readonly calls: RpcCall[]
  callsTo(name: string): RpcCall[]
  /** Replace or add a handler after construction. */
  on(name: string, handler: RpcHandler): void
}

export function createFakeSupabase(
  handlers: Readonly<Record<string, RpcHandler>> = {},
): FakeSupabase {
  const table = new Map<string, RpcHandler>(Object.entries(handlers))
  const calls: RpcCall[] = []
  const clientFor = (kind: FakeClientKind): SupabaseRpcClient => ({
    async rpc(name, args = {}) {
      const call: RpcCall = { client: kind, name, args }
      calls.push(call)
      const handler = table.get(name)
      if (handler === undefined) {
        return { data: null, error: { message: `no handler for rpc ${name}`, code: '42883' } }
      }
      try {
        const data = await handler(args, call)
        return { data: data === undefined ? null : data, error: null }
      } catch (cause) {
        if (cause instanceof FakeRpcFailure) return { data: null, error: cause.error }
        throw cause
      }
    },
  })
  return {
    admin: clientFor('admin'),
    anon: clientFor('anon'),
    forUser: (token) => clientFor(`user:${token}`),
    calls,
    callsTo: (name) => calls.filter((call) => call.name === name),
    on: (name, handler) => {
      table.set(name, handler)
    },
  }
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export interface FakePushSender {
  readonly sender: ServerDeps['push']
  readonly batches: PushMessage[][]
  readonly messages: PushMessage[]
  /** Decides the ticket for a message; defaults to `ok`. */
  ticketFor: (message: PushMessage, index: number) => PushTicket
}

export function createFakePushSender(): FakePushSender {
  const batches: PushMessage[][] = []
  const messages: PushMessage[] = []
  const fake: FakePushSender = {
    batches,
    messages,
    ticketFor: (_message, index) => ({ status: 'ok', id: `ticket-${index}` }),
    sender: {
      async send(batch) {
        batches.push([...batch])
        messages.push(...batch)
        return batch.map((message, index) => fake.ticketFor(message, index))
      },
    },
  }
  return fake
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface SignedUrlCall {
  readonly bucket: string
  readonly path: string
  readonly expiresIn: number
}

export interface FakeStorage {
  readonly storage: StorageLike
  readonly calls: SignedUrlCall[]
  /** What the next `createSignedUrl` answers; defaults to a deterministic signed URL. */
  signFor: (call: SignedUrlCall) => SignedUrlResult
}

export const FAKE_STORAGE_ORIGIN = 'https://storage.test' as const

export function createFakeStorage(): FakeStorage {
  const calls: SignedUrlCall[] = []
  const fake: FakeStorage = {
    calls,
    signFor: (call) => ({
      data: {
        signedUrl: `${FAKE_STORAGE_ORIGIN}/object/sign/${call.bucket}/${call.path}?token=t-${call.expiresIn}`,
      },
      error: null,
    }),
    storage: {
      from: (bucket) => ({
        async createSignedUrl(path, expiresIn) {
          const call: SignedUrlCall = { bucket, path, expiresIn }
          calls.push(call)
          return fake.signFor(call)
        },
      }),
    },
  }
  return fake
}

// ---------------------------------------------------------------------------
// Verification provider
// ---------------------------------------------------------------------------

export const FAKE_SESSION_PREFIX = 'fake-session-' as const

export class FakeVerificationProvider implements HumanVerificationProvider {
  readonly kind
  readonly starts: StartVerificationInput[] = []
  readonly resultReads: string[] = []
  readonly webhooks: { rawBody: string; signature: string | null }[] = []
  private counter = 0
  /** Result per session id; `resultFor` builds one when unset. */
  readonly results = new Map<string, VerificationResult>()
  resultFor: (sessionId: string) => VerificationResult = (sessionId) => ({
    status: 'verified',
    riskLevel: 'low',
    providerReference: `ref:${sessionId}`,
    duplicateOfHumanId: null,
    metadata: { provider: 'fake', secret: 'never-shown' },
  })
  mode: VerificationSession['mode'] = 'mock'
  url: string | undefined = undefined
  webhookHandler:
    ((rawBody: string, signature: string | null) => VerificationWebhookEvent) | undefined

  constructor(kind: ServerEnv['HUMAN_VERIFICATION_PROVIDER'] = 'mock') {
    this.kind = kind
  }

  async startVerification(input: StartVerificationInput): Promise<VerificationSession> {
    this.starts.push(input)
    this.counter += 1
    const sessionId = `${FAKE_SESSION_PREFIX}${this.counter}`
    const session: VerificationSession = {
      sessionId,
      provider: this.kind,
      mode: this.mode,
      expiresAt: '2026-09-03T12:15:00.000Z',
    }
    return this.url === undefined ? session : { ...session, url: this.url }
  }

  async getVerificationResult(sessionId: string): Promise<VerificationResult> {
    this.resultReads.push(sessionId)
    return this.results.get(sessionId) ?? this.resultFor(sessionId)
  }

  async verifyWebhook(
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<VerificationWebhookEvent> {
    this.webhooks.push({ rawBody, signature: signatureHeader })
    if (this.webhookHandler === undefined) throw new Error('no webhook handler configured')
    return this.webhookHandler(rawBody, signatureHeader)
  }
}

/** A provider without `verifyWebhook` (mock / manual review shape). */
export function withoutWebhook(provider: FakeVerificationProvider): HumanVerificationProvider {
  return {
    kind: provider.kind,
    startVerification: (input) => provider.startVerification(input),
    getVerificationResult: (id) => provider.getVerificationResult(id),
  }
}

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export const TEST_NOW = new Date('2026-09-03T12:00:00.000Z')
export const TEST_CRON_SECRET = 'cron-secret-0123456789abcdef'
export const TEST_LIVEKIT = {
  apiKey: 'devkey',
  apiSecret: 'devsecret-devsecret-devsecret-devsecret',
  url: 'ws://localhost:7880',
} as const
export const TEST_HUMAN_ID = '11111111-1111-4111-8111-111111111111' as HumanId

export function testServerEnv(overrides: Partial<Record<keyof ServerEnv, string>> = {}): ServerEnv {
  return ServerEnvSchema.parse({
    APP_ENV: 'development',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_JWT_SECRET: 'jwt-secret-jwt-secret-jwt-secret-jwt-secret',
    LIVEKIT_API_KEY: TEST_LIVEKIT.apiKey,
    LIVEKIT_API_SECRET: TEST_LIVEKIT.apiSecret,
    LIVEKIT_URL: TEST_LIVEKIT.url,
    HUMAN_VERIFICATION_PROVIDER: 'mock',
    INTERNAL_CRON_SECRET: TEST_CRON_SECRET,
    ...overrides,
  })
}

export interface FakeAnalyticsSink {
  readonly sink: ServerDeps['analytics']
  readonly batches: { events: readonly AnalyticsEnvelope[]; context: AnalyticsSinkContext }[]
  fail: boolean
}

export function createFakeAnalyticsSink(): FakeAnalyticsSink {
  const batches: FakeAnalyticsSink['batches'] = []
  const fake: FakeAnalyticsSink = {
    batches,
    fail: false,
    sink: {
      async ingest(events, context) {
        if (fake.fail) throw new Error('sink down')
        batches.push({ events, context })
      },
    },
  }
  return fake
}

export interface FakeDeps {
  readonly deps: ServerDeps
  readonly supabase: FakeSupabase
  readonly storage: FakeStorage
  readonly push: FakePushSender
  readonly analytics: FakeAnalyticsSink
  readonly logs: MemorySink
  readonly verification: FakeVerificationProvider
  readonly clock: { now: Date }
}

export interface FakeDepsOptions {
  readonly rpc?: Readonly<Record<string, RpcHandler>>
  readonly verification?: HumanVerificationProvider
  readonly livekit?: Partial<ServerDeps['livekit']>
  readonly now?: Date
  readonly cronSecret?: string
  /** `false` drops `deps.storage` (Storage not configured). */
  readonly storage?: boolean
}

export function createFakeDeps(options: FakeDepsOptions = {}): FakeDeps {
  const supabase = createFakeSupabase(options.rpc)
  const storage = createFakeStorage()
  const push = createFakePushSender()
  const analytics = createFakeAnalyticsSink()
  const logs = createMemorySink()
  const clock = { now: options.now ?? TEST_NOW }
  const fakeProvider = new FakeVerificationProvider()
  const verification = options.verification ?? fakeProvider
  const env = testServerEnv()
  const deps: ServerDeps = {
    supabaseAdmin: supabase.admin,
    supabaseAnon: supabase.anon,
    supabaseForUser: (token) => supabase.forUser(token),
    livekit: { ...TEST_LIVEKIT, ...options.livekit },
    verification,
    push: push.sender,
    analytics: analytics.sink,
    logger: createLogger({ sink: logs.sink, level: 'debug', now: () => clock.now }),
    now: () => clock.now,
    env,
    cronSecret: options.cronSecret ?? TEST_CRON_SECRET,
    storage: options.storage === false ? undefined : storage.storage,
  }
  return { deps, supabase, storage, push, analytics, logs, verification: fakeProvider, clock }
}
