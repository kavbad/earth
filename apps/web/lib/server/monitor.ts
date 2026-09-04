/**
 * Error monitoring for the server tier (spec §14; ARCHITECTURE §6): a no-op monitor by default,
 * Sentry when `SENTRY_DSN` is set. The Sentry SDK (`@sentry/nextjs`) is injected by
 * `./deps.ts` so this module — and its tests — never load it; `createSentryMonitor` of
 * `@earth/observability` does the redaction and the `EarthError` enrichment.
 *
 * `createMonitoringSink` connects the structured logger to the monitor: every `error` record
 * (for example `server.request_failed` for a 5xx) is also captured, so a hosted backend sees what
 * the logs see without handlers calling the monitor themselves.
 */
import type { AppEnv } from '@earth/config'
import {
  type ErrorMonitor,
  type LogLevel,
  type LogSink,
  type MonitorContext,
  type SentryLike,
  createNoopMonitor,
  createSentryMonitor,
} from '@earth/observability'

/** What `Sentry.init` is given; a subset of the SDK's `NodeOptions`. */
export interface SentryInitOptions {
  readonly dsn: string
  readonly environment: string
  readonly release: string
  /** Never send request bodies, cookies or IPs by default (spec §14: no PII in error reports). */
  readonly sendDefaultPii: boolean
}

/** The `@sentry/nextjs` namespace, structurally: the monitor surface plus `init`. */
export interface SentrySdkLike extends SentryLike {
  init(options: SentryInitOptions): unknown
}

export const SERVER_MONITOR_KINDS = ['noop', 'sentry'] as const
export type ServerMonitorKind = (typeof SERVER_MONITOR_KINDS)[number]

export interface ServerMonitorOptions {
  /** `SENTRY_DSN`; unset selects the no-op monitor. */
  readonly dsn: string | undefined
  readonly appEnv: AppEnv
  readonly release: string
  /** Required to actually report; `undefined` with a DSN set still yields the no-op monitor. */
  readonly sentry: SentrySdkLike | undefined
  readonly now?: (() => Date) | undefined
}

export interface ServerMonitor {
  readonly kind: ServerMonitorKind
  readonly monitor: ErrorMonitor
}

export function createServerMonitor(options: ServerMonitorOptions): ServerMonitor {
  if (options.dsn === undefined || options.sentry === undefined) {
    return { kind: 'noop', monitor: createNoopMonitor() }
  }
  options.sentry.init({
    dsn: options.dsn,
    environment: options.appEnv,
    release: options.release,
    sendDefaultPii: false,
  })
  const monitor = createSentryMonitor(options.sentry, {
    release: options.release,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  return { kind: 'sentry', monitor }
}

/** Log level at and above which records are forwarded to the monitor. */
export const MONITOR_FORWARD_LEVEL: LogLevel = 'error'
/** Field of an `error` record carrying the `EarthError` code (set by `mapError` in `@earth/server`). */
export const LOG_CODE_FIELD = 'code' as const

/** Wraps a sink so `error` records are also captured by `monitor` (fields already redacted). */
export function createMonitoringSink(inner: LogSink, monitor: ErrorMonitor): LogSink {
  return (line, record) => {
    inner(line, record)
    if (record.level !== MONITOR_FORWARD_LEVEL) return
    const code = record.fields[LOG_CODE_FIELD]
    const context: MonitorContext =
      typeof code === 'string'
        ? { tags: { [LOG_CODE_FIELD]: code }, extra: record.fields }
        : { extra: record.fields }
    monitor.captureMessage(record.msg, 'error', context)
  }
}
