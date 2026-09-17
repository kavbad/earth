/**
 * Server instrumentation (Next `register` + `onRequestError`).
 *
 * `register` runs once when a server instance starts, before it takes requests: it initialises
 * Sentry for the Node runtime when `SENTRY_DSN` is set, so an error thrown while *rendering* is
 * reported even if no `/api` request has built the server-tier context yet
 * (`lib/server/wiring.ts` initialises the same SDK, with the same options, on that path).
 * `onRequestError` then hands Next's server errors — server components, route handlers, actions —
 * to Sentry with the request and route context it provides.
 *
 * Nothing here may throw: a broken environment must still boot and answer `503` on
 * `/api/health` with the offending variables, which is far more useful than a dead server. The
 * options are therefore read defensively instead of through `loadWebServerEnv`, and the SDK is
 * imported lazily so the Edge runtime never loads the Node build.
 */
import { RELEASE_COMMIT_PATTERN, buildRelease } from '@earth/observability'
// Type-only: erased at compile time, so neither runtime loads the SDK unless `register` does.
import type * as SentryNextjs from '@sentry/nextjs'

import packageJson from './package.json'

/** Must equal `WEB_APP_NAME` in `lib/server/env.ts` (asserted by the test). */
export const SERVER_RELEASE_APP = 'earth-web' as const
export const SERVER_APP_VERSION: string = packageJson.version

export const SENTRY_DSN_VARIABLE = 'SENTRY_DSN' as const
export const APP_ENV_VARIABLE = 'APP_ENV' as const
export const PUBLIC_APP_ENV_VARIABLE = 'NEXT_PUBLIC_APP_ENV' as const
export const COMMIT_VARIABLE = 'VERCEL_GIT_COMMIT_SHA' as const
export const NEXT_RUNTIME_VARIABLE = 'NEXT_RUNTIME' as const

export const NODE_RUNTIME = 'nodejs' as const
export const DEFAULT_APP_ENV = 'development' as const

export interface ServerSentryOptions {
  readonly dsn: string
  readonly environment: string
  readonly release: string
  /** Never attach IPs, cookies or bodies to an event (spec §14: no PII in error reports). */
  readonly sendDefaultPii: false
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim()
  return result === undefined || result === '' ? undefined : result
}

/** `earth-web@<version>[+<commit>]` — the same shape `releaseFor` builds in `lib/server/env.ts`. */
export function serverRelease(commit: string | undefined): string {
  const sha = trimmed(commit)?.toLowerCase()
  return buildRelease(
    sha !== undefined && RELEASE_COMMIT_PATTERN.test(sha)
      ? { app: SERVER_RELEASE_APP, version: SERVER_APP_VERSION, commit: sha }
      : { app: SERVER_RELEASE_APP, version: SERVER_APP_VERSION },
  )
}

/**
 * The `Sentry.init` options for this runtime, or `null` when Sentry must not start: no DSN, or a
 * runtime other than Node (the Edge proxy has no server tier to report for).
 */
export function serverSentryOptions(
  source: Readonly<Record<string, string | undefined>>,
): ServerSentryOptions | null {
  const runtime = trimmed(source[NEXT_RUNTIME_VARIABLE])
  if (runtime !== undefined && runtime !== NODE_RUNTIME) return null
  const dsn = trimmed(source[SENTRY_DSN_VARIABLE])
  if (dsn === undefined) return null
  return {
    dsn,
    environment:
      trimmed(source[APP_ENV_VARIABLE]) ??
      trimmed(source[PUBLIC_APP_ENV_VARIABLE]) ??
      DEFAULT_APP_ENV,
    release: serverRelease(source[COMMIT_VARIABLE]),
    sendDefaultPii: false,
  }
}

export async function register(): Promise<void> {
  const options = serverSentryOptions(process.env)
  if (options === null) return
  try {
    const Sentry = await import('@sentry/nextjs')
    Sentry.init(options)
  } catch {
    // Monitoring must never be the reason a server fails to start.
  }
}

/** Exactly what Next's `onRequestError` passes: `(error, request, context)`. */
type CaptureRequestErrorArgs = Parameters<typeof SentryNextjs.captureRequestError>

export async function onRequestError(...args: CaptureRequestErrorArgs): Promise<void> {
  try {
    const Sentry = await import('@sentry/nextjs')
    Sentry.captureRequestError(...args)
  } catch {
    // A monitor that cannot report must not turn one failed request into two.
  }
}
