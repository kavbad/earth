/**
 * @earth/server — Pure server-tier handlers (token, webhooks, push, verification, feed, sweeps)
 * with injected deps (ARCHITECTURE §6, ADR-001). Single public entry point of the package.
 *
 * Mounting (Next route handler):
 *
 * ```ts
 * const deps = createServerDepsFromEnv({ env, supabase, createSupabaseClient: createClient, verification })
 * const server = createEarthServer(deps)
 * export const POST = createFetchHandler(server)
 * ```
 */
import type { AnalyticsSink } from '@earth/analytics'
import type { ServerEnv } from '@earth/config'
import { type Logger, createLogger } from '@earth/observability'

import type {
  AuthAdminHostLike,
  AuthAdminLike,
  LiveKitWebhookReceiverLike,
  PushSender,
  ServerDeps,
  StorageHostLike,
  StorageLike,
  SupabaseRpcClient,
} from './deps'
import { type ExpoClientLike, createExpoPushSender } from './push/expo'
import { createDisabledPushSender } from './push/noop'
import type { HumanVerificationProvider } from './verification/provider-types'

export const PACKAGE_NAME = '@earth/server' as const

export * from './deps'
export * from './http'
export * from './cron'
export * from './verification/provider-types'
export * from './rooms/token'
export * from './rooms/webhook'
export * from './rooms/sweep'
export * from './feed/rows'
export * from './feed/live-order'
export * from './feed/handler'
export * from './claim/verification'
export * from './push/messages'
export * from './push/expo'
export * from './push/noop'
export * from './push/dispatch'
export * from './analytics/ingest'
export * from './media/signed'
export * from './diagnostics/rtc'
export * from './metrics/daily'
export * from './account/delete'
export * from './router'
export * from './adapters/fetch'

// ---------------------------------------------------------------------------
// Real wiring
// ---------------------------------------------------------------------------

/** The `createClient` options the server passes (a subset of `SupabaseClientOptions`). */
export interface SupabaseClientOptionsLike {
  readonly auth: {
    readonly persistSession: false
    readonly autoRefreshToken: false
    readonly detectSessionInUrl: false
  }
  readonly global: { readonly headers: Readonly<Record<string, string>> }
}

/** `createClient` of `@supabase/supabase-js`, structurally. */
export type SupabaseClientFactory = (
  url: string,
  key: string,
  options: SupabaseClientOptionsLike,
) => SupabaseRpcClient

export interface SupabaseConnection {
  /** `SUPABASE_URL` (public env). */
  readonly url: string
  /** `SUPABASE_ANON_KEY` (public env); per-user clients carry the caller's bearer on top. */
  readonly anonKey: string
}

export interface CreateServerDepsOptions {
  readonly env: ServerEnv
  readonly supabase: SupabaseConnection
  readonly createSupabaseClient: SupabaseClientFactory
  /**
   * The Human verification provider, or a factory over the env. The app builds it with
   * `createVerificationProvider(env, ...)` from `@earth/auth` (which refuses `mock` in production).
   */
  readonly verification: HumanVerificationProvider | ((env: ServerEnv) => HumanVerificationProvider)
  /** `new Expo({ accessToken: env.EXPO_ACCESS_TOKEN })`; without it push delivery is disabled. */
  readonly expoClient?: ExpoClientLike | undefined
  /** Overrides `expoClient`. */
  readonly push?: PushSender | undefined
  /** Vendor analytics sink; defaults to a no-op (the first-party store is written by the RPC). */
  readonly analytics?: AnalyticsSink | undefined
  readonly logger?: Logger | undefined
  readonly now?: (() => Date) | undefined
  readonly webhookReceiver?: LiveKitWebhookReceiverLike | undefined
  /** Overrides the `auth.admin` found on the service-role client (`authAdminOf`). */
  readonly authAdmin?: AuthAdminLike | undefined
  /** Overrides the `storage` found on the service-role client (`storageOf`). */
  readonly storage?: StorageLike | undefined
}

/** The `auth.admin` a service-role client carries, when it does (the RPC-only fakes do not). */
export function authAdminOf(
  client: SupabaseRpcClient & AuthAdminHostLike,
): AuthAdminLike | undefined {
  const admin = client.auth?.admin
  return admin !== undefined && typeof admin.deleteUser === 'function' ? admin : undefined
}

/** The `storage` a service-role client carries, when it does (the RPC-only fakes do not). */
export function storageOf(client: SupabaseRpcClient & StorageHostLike): StorageLike | undefined {
  const storage = client.storage
  return storage !== undefined && typeof storage.from === 'function' ? storage : undefined
}

const CLIENT_AUTH_OPTIONS = {
  persistSession: false,
  autoRefreshToken: false,
  detectSessionInUrl: false,
} as const

export function createNoopAnalyticsSink(): AnalyticsSink {
  return { ingest: async () => undefined }
}

/** Wires real implementations: service-role, anon and per-user Supabase clients, LiveKit, push. */
export function createServerDepsFromEnv(options: CreateServerDepsOptions): ServerDeps {
  const { env, supabase, createSupabaseClient } = options
  const supabaseAdmin = createSupabaseClient(supabase.url, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: CLIENT_AUTH_OPTIONS,
    global: { headers: {} },
  })
  const supabaseAnon = createSupabaseClient(supabase.url, supabase.anonKey, {
    auth: CLIENT_AUTH_OPTIONS,
    global: { headers: {} },
  })
  const verification =
    typeof options.verification === 'function' ? options.verification(env) : options.verification
  const push =
    options.push ??
    (options.expoClient === undefined
      ? createDisabledPushSender()
      : createExpoPushSender(options.expoClient))
  return {
    supabaseAdmin,
    supabaseAnon,
    supabaseForUser: (accessToken) =>
      createSupabaseClient(supabase.url, supabase.anonKey, {
        auth: CLIENT_AUTH_OPTIONS,
        global: { headers: { Authorization: `Bearer ${accessToken}` } },
      }),
    livekit: {
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
      url: env.LIVEKIT_URL,
      webhookReceiver: options.webhookReceiver,
    },
    verification,
    push,
    analytics: options.analytics ?? createNoopAnalyticsSink(),
    logger: options.logger ?? createLogger({ base: { service: PACKAGE_NAME } }),
    now: options.now ?? (() => new Date()),
    env,
    cronSecret: env.INTERNAL_CRON_SECRET,
    authAdmin: options.authAdmin ?? authAdminOf(supabaseAdmin),
    storage: options.storage ?? storageOf(supabaseAdmin),
  }
}
