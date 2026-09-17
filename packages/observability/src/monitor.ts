/**
 * ErrorMonitor — the runtime exception monitoring boundary required by spec §14 (runtime
 * exceptions, release/version tracking, server-function error logging). Every tier receives an
 * `ErrorMonitor` by injection; adapters live in `./adapters/*` and are chosen by the app.
 *
 * Identity is deliberately narrow: a monitor user is `humans.id` or `guest_sessions.id` plus, for
 * Humans, the public handle. Guest is not Human (spec §128), and no PII (email, phone, exact
 * location) is ever attached to error reports.
 */
import { type GuestSessionId, type HumanId, isEarthError } from '@earth/domain'

import { type LogFields, type LogLevel, type Logger } from './logger'
import { serializeError } from './redact'

export const MONITOR_SEVERITIES = ['debug', 'info', 'warning', 'error', 'fatal'] as const
export type MonitorSeverity = (typeof MONITOR_SEVERITIES)[number]

export const DEFAULT_MESSAGE_SEVERITY: MonitorSeverity = 'info'

/** How each severity maps onto the four logger levels. */
export const MONITOR_SEVERITY_LOG_LEVEL: Readonly<Record<MonitorSeverity, LogLevel>> = {
  debug: 'debug',
  info: 'info',
  warning: 'warn',
  error: 'error',
  fatal: 'error',
}

const SEVERITY_SET: ReadonlySet<string> = new Set<string>(MONITOR_SEVERITIES)

export function isMonitorSeverity(value: unknown): value is MonitorSeverity {
  return typeof value === 'string' && SEVERITY_SET.has(value)
}

export const MONITOR_IDENTITY_KINDS = ['human', 'guest'] as const
export type MonitorIdentityKind = (typeof MONITOR_IDENTITY_KINDS)[number]

export interface HumanMonitorIdentity {
  readonly kind: 'human'
  readonly id: HumanId
  /** Public handle (public identity, not Human identity). Never email or phone. */
  readonly handle?: string
}

export interface GuestMonitorIdentity {
  readonly kind: 'guest'
  readonly id: GuestSessionId
}

export type MonitorIdentity = HumanMonitorIdentity | GuestMonitorIdentity

export type MonitorTagValue = string | number | boolean
export type MonitorTags = Readonly<Record<string, MonitorTagValue>>

export interface MonitorContext {
  /** Indexed, low-cardinality values (release, route, rtc kind). */
  readonly tags?: MonitorTags
  /** Free-form structured data; redacted by adapters that log it. */
  readonly extra?: LogFields
  /** Grouping override for the monitoring backend. */
  readonly fingerprint?: readonly string[]
}

export const BREADCRUMB_CATEGORIES = [
  'rtc',
  'realtime',
  'navigation',
  'http',
  'auth',
  'ui',
  'push',
  'analytics',
] as const
export type BreadcrumbCategory = (typeof BREADCRUMB_CATEGORIES)[number]

export interface Breadcrumb {
  readonly category: BreadcrumbCategory
  readonly message: string
  readonly level?: MonitorSeverity
  readonly data?: LogFields
  /** Milliseconds since epoch; adapters stamp the current time when absent. */
  readonly timestampMs?: number
}

export interface ErrorMonitor {
  captureException(error: unknown, context?: MonitorContext): void
  captureMessage(message: string, level?: MonitorSeverity, context?: MonitorContext): void
  setUser(identity: MonitorIdentity | null): void
  setRelease(release: string): void
  addBreadcrumb(crumb: Breadcrumb): void
  /** Waits for buffered events to be sent; resolves `false` when the timeout elapsed first. */
  flush?(timeoutMs?: number): Promise<boolean>
}

/** Tag carrying `EarthError.code` on captured exceptions, whatever the adapter. */
export const EARTH_ERROR_CODE_TAG = 'earth_error_code' as const
/** `extra` key carrying `EarthError.details` on captured exceptions. */
export const EARTH_ERROR_DETAILS_KEY = 'earth_error_details' as const

interface MutableMonitorContext {
  tags?: MonitorTags
  extra?: LogFields
  fingerprint?: readonly string[]
}

/**
 * Adds the machine code and details of an `EarthError` to the capture context so every adapter
 * reports domain errors identically. Other errors pass through untouched.
 */
export function enrichContextForError(
  error: unknown,
  context?: MonitorContext,
): MonitorContext | undefined {
  if (!isEarthError(error)) return context
  const enriched: MutableMonitorContext = {
    tags: { ...context?.tags, [EARTH_ERROR_CODE_TAG]: error.code },
  }
  const extra =
    error.details === undefined
      ? context?.extra
      : { ...context?.extra, [EARTH_ERROR_DETAILS_KEY]: error.details }
  if (extra !== undefined) enriched.extra = extra
  if (context?.fingerprint !== undefined) enriched.fingerprint = context.fingerprint
  return enriched
}

/** A monitor that drops everything; the default until an app wires an adapter. */
export function createNoopMonitor(): ErrorMonitor {
  const noop = (): void => undefined
  return {
    captureException: noop,
    captureMessage: noop,
    setUser: noop,
    setRelease: noop,
    addBreadcrumb: noop,
    flush: () => Promise.resolve(true),
  }
}

export const DEFAULT_MAX_BREADCRUMBS = 50

/** Log messages emitted by the console monitor. */
export const MONITOR_LOG_MESSAGES = {
  exception: 'monitor.exception',
  breadcrumb: 'monitor.breadcrumb',
  user: 'monitor.user',
  release: 'monitor.release',
} as const

export interface ConsoleMonitorOptions {
  /** Breadcrumbs kept and attached to each captured exception. */
  readonly maxBreadcrumbs?: number
  readonly now?: () => Date
}

/**
 * A monitor that writes to a structured `Logger`: exceptions at `error`, messages at the level
 * matching their severity, breadcrumbs at `debug`. Captured exceptions carry the current user,
 * release and the trailing breadcrumbs, mirroring what a hosted backend would show.
 */
export function createConsoleMonitor(
  logger: Logger,
  options: ConsoleMonitorOptions = {},
): ErrorMonitor {
  const maxBreadcrumbs = Math.max(0, Math.floor(options.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS))
  const now = options.now ?? (() => new Date())
  let user: MonitorIdentity | null = null
  let release: string | null = null
  const breadcrumbs: Breadcrumb[] = []

  const scopeFields = (context: MonitorContext | undefined): LogFields => ({
    tags: context?.tags,
    extra: context?.extra,
    fingerprint: context?.fingerprint,
    user: user ?? undefined,
    release: release ?? undefined,
  })

  return {
    captureException(error, context) {
      const enriched = enrichContextForError(error, context)
      logger.error(MONITOR_LOG_MESSAGES.exception, {
        error: serializeError(error),
        ...scopeFields(enriched),
        breadcrumbs: breadcrumbs.map((crumb) => ({ ...crumb })),
      })
    },
    captureMessage(message, level = DEFAULT_MESSAGE_SEVERITY, context) {
      logger[MONITOR_SEVERITY_LOG_LEVEL[level]](message, {
        severity: level,
        ...scopeFields(context),
      })
    },
    setUser(identity) {
      user = identity
      logger.debug(MONITOR_LOG_MESSAGES.user, {
        user: identity ?? undefined,
        cleared: identity === null,
      })
    },
    setRelease(next) {
      release = next
      logger.debug(MONITOR_LOG_MESSAGES.release, { release: next })
    },
    addBreadcrumb(crumb) {
      const stamped: Breadcrumb =
        crumb.timestampMs === undefined ? { ...crumb, timestampMs: now().getTime() } : crumb
      breadcrumbs.push(stamped)
      if (breadcrumbs.length > maxBreadcrumbs) {
        breadcrumbs.splice(0, breadcrumbs.length - maxBreadcrumbs)
      }
      logger.debug(MONITOR_LOG_MESSAGES.breadcrumb, { ...stamped })
    },
    flush: () => Promise.resolve(true),
  }
}

export type RecordedMonitorCall =
  | {
      readonly method: 'captureException'
      readonly error: unknown
      readonly context?: MonitorContext
    }
  | {
      readonly method: 'captureMessage'
      readonly message: string
      readonly level: MonitorSeverity
      readonly context?: MonitorContext
    }
  | { readonly method: 'setUser'; readonly identity: MonitorIdentity | null }
  | { readonly method: 'setRelease'; readonly release: string }
  | { readonly method: 'addBreadcrumb'; readonly crumb: Breadcrumb }
  | { readonly method: 'flush'; readonly timeoutMs?: number }

export interface RecordingMonitor {
  readonly monitor: ErrorMonitor
  readonly calls: RecordedMonitorCall[]
  clear(): void
}

/** A monitor that records every call; for tests in any package that injects an `ErrorMonitor`. */
export function createRecordingMonitor(): RecordingMonitor {
  const calls: RecordedMonitorCall[] = []
  const monitor: ErrorMonitor = {
    captureException(error, context) {
      calls.push(
        context === undefined
          ? { method: 'captureException', error }
          : { method: 'captureException', error, context },
      )
    },
    captureMessage(message, level = DEFAULT_MESSAGE_SEVERITY, context) {
      calls.push(
        context === undefined
          ? { method: 'captureMessage', message, level }
          : { method: 'captureMessage', message, level, context },
      )
    },
    setUser(identity) {
      calls.push({ method: 'setUser', identity })
    },
    setRelease(release) {
      calls.push({ method: 'setRelease', release })
    },
    addBreadcrumb(crumb) {
      calls.push({ method: 'addBreadcrumb', crumb })
    },
    flush(timeoutMs) {
      calls.push(timeoutMs === undefined ? { method: 'flush' } : { method: 'flush', timeoutMs })
      return Promise.resolve(true)
    },
  }
  return { monitor, calls, clear: () => void (calls.length = 0) }
}

/**
 * Fans every call out to several monitors (for example console + Sentry in preview builds). A
 * monitor that throws does not stop the others; `flush` resolves `true` only when all did.
 */
export function createCompositeMonitor(monitors: readonly ErrorMonitor[]): ErrorMonitor {
  const each = (apply: (monitor: ErrorMonitor) => void): void => {
    for (const monitor of monitors) {
      try {
        apply(monitor)
      } catch {
        // A monitoring adapter must never break the caller; the remaining adapters still run.
      }
    }
  }
  return {
    captureException: (error, context) => each((m) => m.captureException(error, context)),
    captureMessage: (message, level, context) =>
      each((m) => m.captureMessage(message, level, context)),
    setUser: (identity) => each((m) => m.setUser(identity)),
    setRelease: (release) => each((m) => m.setRelease(release)),
    addBreadcrumb: (crumb) => each((m) => m.addBreadcrumb(crumb)),
    async flush(timeoutMs) {
      const results = await Promise.all(monitors.map((m) => flushOne(m, timeoutMs)))
      return results.every(Boolean)
    },
  }
}

/** A monitor without `flush` counts as flushed; one that throws or rejects counts as not. */
function flushOne(monitor: ErrorMonitor, timeoutMs: number | undefined): Promise<boolean> {
  if (monitor.flush === undefined) return Promise.resolve(true)
  try {
    return monitor.flush(timeoutMs).then(
      (flushed) => flushed,
      () => false,
    )
  } catch {
    return Promise.resolve(false)
  }
}
