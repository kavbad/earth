/**
 * The app's `ErrorMonitor` (spec §14): `@sentry/react-native` initialised once from the public
 * environment and handed to the `@earth/observability` adapter, or the console / noop monitor
 * `selectErrorMonitor` picks. Call `getErrorMonitor()` at module scope of the root layout so the
 * SDK is up before the first render and start-up crashes are reported.
 */
import type { ErrorMonitor, SentryLike } from '@earth/observability'
import * as Sentry from '@sentry/react-native'

import packageJson from '../../package.json'
import { isDevelopmentEnv, readPublicEnv } from '../env'
import { mobileRelease, selectErrorMonitor } from './setup'

let cached: ErrorMonitor | undefined

/**
 * `SentryLike` spells its optional members with `| undefined`; the SDK's own types do not, so
 * under `exactOptionalPropertyTypes` the namespace is not assignable as is. The adapter in
 * `@earth/observability` drops every `undefined` member before calling (`defined()`), so
 * narrowing the parameter types here is sound.
 */
function sentryLike(): SentryLike {
  type CaptureContext = Parameters<typeof Sentry.captureException>[1]
  type MessageContext = Parameters<typeof Sentry.captureMessage>[1]
  type User = Parameters<typeof Sentry.setUser>[0]
  type Breadcrumb = Parameters<typeof Sentry.addBreadcrumb>[0]
  return {
    captureException: (exception, captureContext) =>
      Sentry.captureException(exception, captureContext as CaptureContext),
    captureMessage: (message, captureContext) =>
      Sentry.captureMessage(message, captureContext as MessageContext),
    setUser: (user) => Sentry.setUser(user as User),
    addBreadcrumb: (breadcrumb) => Sentry.addBreadcrumb(breadcrumb as Breadcrumb),
    setTag: (key, value) => Sentry.setTag(key, value),
    // The RN SDK flushes with its own timeout; the adapter's hint is not needed here.
    flush: () => Sentry.flush(),
  }
}

function initSentry(dsn: string, release: string, environment: string): SentryLike {
  Sentry.init({
    dsn,
    release,
    environment,
    enableAutoSessionTracking: true,
    // Errors and RTC diagnostics only; performance tracing is not part of V1 (spec §14).
    tracesSampleRate: 0,
    sendDefaultPii: false,
  })
  return sentryLike()
}

export function getErrorMonitor(): ErrorMonitor {
  if (cached !== undefined) return cached
  const release = mobileRelease(packageJson.version)
  const env = readPublicEnv()
  if (!env.ok) {
    // A misconfigured build still logs locally; the shell shows the configuration line.
    cached = selectErrorMonitor({ dsn: undefined, sentry: null, release, isDevelopment: true })
    return cached
  }
  const dsn = env.env.SENTRY_DSN
  let sentry: SentryLike | null = null
  if (dsn !== undefined) {
    try {
      sentry = initSentry(dsn, release, env.env.APP_ENV)
    } catch {
      sentry = null
    }
  }
  cached = selectErrorMonitor({ dsn, sentry, release, isDevelopment: isDevelopmentEnv(env.env) })
  return cached
}

/** Tests only. */
export function resetErrorMonitor(): void {
  cached = undefined
}
