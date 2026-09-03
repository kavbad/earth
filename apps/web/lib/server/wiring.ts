/**
 * Builds the mounted server tier from an environment source and injected SDK factories
 * (ARCHITECTURE §6). Pure: nothing here reads `process.env` or imports a vendor SDK, so tests
 * construct the whole context with fakes. `./deps.ts` supplies the real factories and memoises
 * one context per process.
 */
import {
  type EarthServer,
  type ExpoClientLike,
  type LiveKitWebhookReceiverLike,
  type ServerDeps,
  type SupabaseClientOptionsLike,
  type SupabaseRpcClient,
  createEarthServer,
  createServerDepsFromEnv,
} from '@earth/server'
import type { EnvSource } from '@earth/config'
import {
  type ErrorMonitor,
  type LogSink,
  type Logger,
  createConsoleSink,
  createLogger,
} from '@earth/observability'

import type { CronCredentials } from './cron'
import { WEB_APP_NAME, type WebServerEnv, loadWebServerEnv } from './env'
import {
  type SentrySdkLike,
  type ServerMonitorKind,
  createMonitoringSink,
  createServerMonitor,
} from './monitor'
import { type SupabaseTableClientLike, createVerificationProviderFromEnv } from './verification'

/** A supabase-js client as the server tier uses it: RPCs plus the one table the review store touches. */
export type WebSupabaseClient = SupabaseRpcClient & SupabaseTableClientLike

/** `createClient` of `@supabase/supabase-js`, structurally. */
export type WebSupabaseClientFactory = (
  url: string,
  key: string,
  options: SupabaseClientOptionsLike,
) => WebSupabaseClient

/** `new Expo({ accessToken })` of `expo-server-sdk`, structurally. */
export type ExpoClientFactory = (accessToken: string) => ExpoClientLike

export interface WebServerWiringOptions {
  /** `process.env` in production; an object in tests. */
  readonly source: EnvSource
  readonly createSupabaseClient: WebSupabaseClientFactory
  readonly createExpoClient: ExpoClientFactory
  /** `@sentry/nextjs`; `undefined` disables Sentry even when `SENTRY_DSN` is set. */
  readonly sentry: SentrySdkLike | undefined
  /** Defaults to the console (one JSON line per record). */
  readonly logSink?: LogSink | undefined
  readonly now?: (() => Date) | undefined
  /** Replaces the LiveKit `WebhookReceiver` built from the API key/secret (tests). */
  readonly webhookReceiver?: LiveKitWebhookReceiverLike | undefined
}

export interface WebServerContext {
  readonly env: WebServerEnv
  readonly deps: ServerDeps
  readonly server: EarthServer
  readonly logger: Logger
  readonly monitor: ErrorMonitor
  readonly monitorKind: ServerMonitorKind
  readonly cron: CronCredentials
}

const SERVICE_CLIENT_OPTIONS: SupabaseClientOptionsLike = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: {} },
}

/**
 * Validates the environment and wires real dependencies: service-role, anon and per-user
 * Supabase clients, LiveKit, the verification provider, Expo push (when `EXPO_ACCESS_TOKEN` is
 * set), the structured logger and the error monitor.
 *
 * @throws {EnvError} when the environment is invalid; `VerificationConfigError` for a provider
 *   the environment forbids (for example `mock` in production).
 */
export function createWebServerContext(options: WebServerWiringOptions): WebServerContext {
  const env = loadWebServerEnv(options.source)
  const now = options.now ?? (() => new Date())
  const { monitor, kind: monitorKind } = createServerMonitor({
    dsn: env.server.SENTRY_DSN,
    appEnv: env.server.APP_ENV,
    release: env.release,
    sentry: options.sentry,
    now,
  })
  const logger = createLogger({
    level: env.logLevel,
    sink: createMonitoringSink(options.logSink ?? createConsoleSink(), monitor),
    base: { service: WEB_APP_NAME, release: env.release, appEnv: env.server.APP_ENV },
    now,
  })
  // The review store needs table access, which `ServerDeps.supabaseAdmin` does not expose.
  const reviewStore = options.createSupabaseClient(
    env.public.SUPABASE_URL,
    env.server.SUPABASE_SERVICE_ROLE_KEY,
    SERVICE_CLIENT_OPTIONS,
  )
  const verification = createVerificationProviderFromEnv(env.server, {
    supabaseAdmin: reviewStore,
    now,
  })
  const expoClient =
    env.server.EXPO_ACCESS_TOKEN === undefined
      ? undefined
      : options.createExpoClient(env.server.EXPO_ACCESS_TOKEN)
  const deps = createServerDepsFromEnv({
    env: env.server,
    supabase: { url: env.public.SUPABASE_URL, anonKey: env.public.SUPABASE_ANON_KEY },
    createSupabaseClient: options.createSupabaseClient,
    verification,
    expoClient,
    logger,
    now,
    webhookReceiver: options.webhookReceiver,
  })
  return {
    env,
    deps,
    server: createEarthServer(deps),
    logger,
    monitor,
    monitorKind,
    cron: {
      internalSecret: env.server.INTERNAL_CRON_SECRET,
      vercelCronSecret: env.vercelCronSecret,
    },
  }
}
