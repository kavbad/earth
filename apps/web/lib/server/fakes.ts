/**
 * Test doubles for the mounted server tier: an environment source with the `.env.example`
 * values, a recording Supabase factory (RPC handlers per name, an in-memory `identity_reviews`
 * table, one recorded creation per client), a recording Sentry namespace, a recording Expo
 * factory, and `createTestContext` wiring them through the real `createWebServerContext`.
 * Never imported by runtime code.
 */
import type { EnvSource } from '@earth/config'
import type { IdentityReviewStatus } from '@earth/auth'
import type {
  ExpoClientLike,
  ExpoPushMessageLike,
  LiveKitWebhookReceiverLike,
  RpcArgs,
  RpcError,
} from '@earth/server'
import { type MemorySink, createMemorySink } from '@earth/observability'

import type { SentryInitOptions, SentrySdkLike } from './monitor'
import {
  IDENTITY_REVIEWS_TABLE,
  type IdentityReviewInsert,
  type IdentityReviewsTableLike,
  type TableResult,
} from './verification'
import {
  type ExpoClientFactory,
  type WebServerContext,
  type WebSupabaseClientFactory,
  createWebServerContext,
} from './wiring'

export const TEST_NOW = new Date('2026-09-03T12:00:00.000Z')
export const TEST_SUPABASE_URL = 'http://localhost:54321'
export const TEST_ANON_KEY = 'anon-key'
export const TEST_SERVICE_KEY = 'service-role-key'
export const TEST_CRON_SECRET = 'internal-cron-secret-0123456789'
export const TEST_VERCEL_CRON_SECRET = 'vercel-cron-secret-abcdefghijkl'
export const TEST_LIVEKIT = {
  apiKey: 'devkey',
  apiSecret: 'secret',
  url: 'ws://localhost:7880',
} as const

/** The `.env.example` values (mock verification, development) with `overrides` on top. */
export function testEnvSource(overrides: EnvSource = {}): EnvSource {
  return {
    NEXT_PUBLIC_SUPABASE_URL: TEST_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: TEST_ANON_KEY,
    NEXT_PUBLIC_API_BASE_URL: 'http://localhost:3000',
    NEXT_PUBLIC_LIVEKIT_URL: TEST_LIVEKIT.url,
    NEXT_PUBLIC_MAP_STYLE_URL: 'https://demotiles.maplibre.org/style.json',
    NEXT_PUBLIC_APP_ENV: 'development',
    NEXT_PUBLIC_WEB_ORIGIN: 'http://localhost:3000',
    APP_ENV: 'development',
    SUPABASE_SERVICE_ROLE_KEY: TEST_SERVICE_KEY,
    SUPABASE_JWT_SECRET: 'jwt-secret-jwt-secret-jwt-secret-jwt-secret',
    LIVEKIT_API_KEY: TEST_LIVEKIT.apiKey,
    LIVEKIT_API_SECRET: TEST_LIVEKIT.apiSecret,
    LIVEKIT_URL: TEST_LIVEKIT.url,
    HUMAN_VERIFICATION_PROVIDER: 'mock',
    INTERNAL_CRON_SECRET: TEST_CRON_SECRET,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Supabase
// ---------------------------------------------------------------------------

export type FakeClientKind = 'admin' | 'anon' | `user:${string}`

export interface FakeSupabaseCreation {
  readonly url: string
  readonly key: string
  readonly kind: FakeClientKind
}

export interface FakeRpcCall {
  readonly kind: FakeClientKind
  readonly name: string
  readonly args: RpcArgs
}

export type FakeRpcHandler = (args: RpcArgs, call: FakeRpcCall) => unknown

/** Thrown by a handler to make the fake return `{ data: null, error }` (a Postgres error). */
export class FakeRpcFailure {
  constructor(readonly error: RpcError) {}
}

/** `raise exception using errcode = 'P0001', message = '<code>'` as PostgREST reports it. */
export function rpcFailure(code: string): FakeRpcFailure {
  return new FakeRpcFailure({ message: code, code: 'P0001', details: null, hint: null })
}

export interface FakeIdentityReview extends IdentityReviewInsert {
  readonly id: string
}

export interface FakeSupabase {
  readonly factory: WebSupabaseClientFactory
  readonly creations: FakeSupabaseCreation[]
  readonly calls: FakeRpcCall[]
  /** The in-memory `identity_reviews` table shared by every client the factory creates. */
  readonly reviews: FakeIdentityReview[]
  /** When set, every table operation fails with this message. */
  tableError: string | null
  callsTo(name: string): FakeRpcCall[]
  on(name: string, handler: FakeRpcHandler): void
  setReviewStatus(id: string, status: IdentityReviewStatus): void
}

const BEARER = /^Bearer\s+/i

export function createFakeSupabase(
  handlers: Readonly<Record<string, FakeRpcHandler>> = {},
): FakeSupabase {
  const table = new Map<string, FakeRpcHandler>(Object.entries(handlers))
  const creations: FakeSupabaseCreation[] = []
  const calls: FakeRpcCall[] = []
  let reviews: FakeIdentityReview[] = []
  let nextReviewId = 1

  const failure = (): TableResult | null =>
    fake.tableError === null ? null : { data: null, error: { message: fake.tableError } }

  const reviewsTable = (name: string): IdentityReviewsTableLike => ({
    insert: (row) => ({
      select: () => ({
        single: async () => {
          const failed = failure()
          if (failed !== null) return failed
          if (name !== IDENTITY_REVIEWS_TABLE)
            return { data: null, error: { message: `no table ${name}` } }
          const id = `review-${nextReviewId}`
          nextReviewId += 1
          reviews.push({ ...row, id })
          return { data: { id }, error: null }
        },
      }),
    }),
    select: () => ({
      eq: (column, value) => ({
        maybeSingle: async () => {
          const failed = failure()
          if (failed !== null) return failed
          const found = reviews.find(
            (review) => review[column as keyof FakeIdentityReview] === value,
          )
          return { data: found === undefined ? null : { status: found.status }, error: null }
        },
      }),
    }),
  })

  const factory: WebSupabaseClientFactory = (url, key, options) => {
    const auth = options.global.headers['Authorization'] ?? options.global.headers['authorization']
    const kind: FakeClientKind =
      key === TEST_SERVICE_KEY
        ? 'admin'
        : auth === undefined
          ? 'anon'
          : `user:${auth.replace(BEARER, '')}`
    creations.push({ url, key, kind })
    return {
      async rpc(name, args = {}) {
        const call: FakeRpcCall = { kind, name, args }
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
      from: reviewsTable,
    }
  }

  const fake: FakeSupabase = {
    factory,
    creations,
    calls,
    get reviews() {
      return reviews
    },
    tableError: null,
    callsTo: (name) => calls.filter((call) => call.name === name),
    on: (name, handler) => {
      table.set(name, handler)
    },
    setReviewStatus: (id, status) => {
      reviews = reviews.map((review) => (review.id === id ? { ...review, status } : review))
    },
  }
  return fake
}

// ---------------------------------------------------------------------------
// Sentry
// ---------------------------------------------------------------------------

export interface FakeSentry {
  readonly sdk: SentrySdkLike
  readonly inits: SentryInitOptions[]
  readonly exceptions: { readonly exception: unknown; readonly context: unknown }[]
  readonly messages: { readonly message: string; readonly context: unknown }[]
  readonly users: unknown[]
  readonly breadcrumbs: unknown[]
  readonly tags: Record<string, string>
  flushes: number
}

export function createFakeSentry(): FakeSentry {
  const fake: FakeSentry = {
    inits: [],
    exceptions: [],
    messages: [],
    users: [],
    breadcrumbs: [],
    tags: {},
    flushes: 0,
    sdk: {
      init: (options) => fake.inits.push(options),
      captureException: (exception, context) => fake.exceptions.push({ exception, context }),
      captureMessage: (message, context) => fake.messages.push({ message, context }),
      setUser: (user) => fake.users.push(user),
      addBreadcrumb: (crumb) => fake.breadcrumbs.push(crumb),
      setTag: (key, value) => {
        fake.tags[key] = value
      },
      flush: async () => {
        fake.flushes += 1
        return true
      },
    },
  }
  return fake
}

// ---------------------------------------------------------------------------
// Expo
// ---------------------------------------------------------------------------

export interface FakeExpo {
  readonly factory: ExpoClientFactory
  /** Access tokens the factory was given. */
  readonly tokens: string[]
  readonly sent: ExpoPushMessageLike[]
}

export function createFakeExpo(): FakeExpo {
  const tokens: string[] = []
  const sent: ExpoPushMessageLike[] = []
  const client: ExpoClientLike = {
    chunkPushNotifications: (messages) => (messages.length === 0 ? [] : [messages]),
    sendPushNotificationsAsync: async (messages) => {
      sent.push(...messages)
      return messages.map((_message, index) => ({ status: 'ok' as const, id: `receipt-${index}` }))
    },
  }
  return {
    tokens,
    sent,
    factory: (accessToken) => {
      tokens.push(accessToken)
      return client
    },
  }
}

// ---------------------------------------------------------------------------
// Context and requests
// ---------------------------------------------------------------------------

export interface TestContextOptions {
  readonly env?: EnvSource
  readonly rpc?: Readonly<Record<string, FakeRpcHandler>>
  readonly webhookReceiver?: LiveKitWebhookReceiverLike
}

export interface TestContext {
  readonly context: WebServerContext
  readonly supabase: FakeSupabase
  readonly sentry: FakeSentry
  readonly expo: FakeExpo
  readonly logs: MemorySink
}

export function createTestContext(options: TestContextOptions = {}): TestContext {
  const supabase = createFakeSupabase(options.rpc)
  const sentry = createFakeSentry()
  const expo = createFakeExpo()
  const logs = createMemorySink()
  const context = createWebServerContext({
    source: testEnvSource(options.env),
    createSupabaseClient: supabase.factory,
    createExpoClient: expo.factory,
    sentry: sentry.sdk,
    logSink: logs.sink,
    now: () => TEST_NOW,
    webhookReceiver: options.webhookReceiver,
  })
  return { context, supabase, sentry, expo, logs }
}

export interface WebRequestInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  /** Objects are JSON-encoded; strings are sent verbatim. */
  readonly body?: string | object
  readonly bearer?: string
}

export const TEST_ORIGIN = 'http://localhost:3000'

/** A Fetch `Request` for `path` on the test origin (method defaults to GET, POST with a body). */
export function webRequest(path: string, init: WebRequestInit = {}): Request {
  const headers = new Headers(init.headers)
  if (init.bearer !== undefined) headers.set('authorization', `Bearer ${init.bearer}`)
  const body =
    init.body === undefined
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : JSON.stringify(init.body)
  if (body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  const method = init.method ?? (body === undefined ? 'GET' : 'POST')
  return new Request(
    `${TEST_ORIGIN}${path}`,
    body === undefined ? { method, headers } : { method, headers, body },
  )
}

export async function readJson(response: Response): Promise<unknown> {
  return (await response.json()) as unknown
}
