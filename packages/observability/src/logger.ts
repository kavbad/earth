/**
 * Structured logger (spec §131 "structured logging"; ARCHITECTURE §6 injects it as
 * `ServerDeps.logger`).
 *
 * Every record is emitted to the sink as one line of JSON shaped exactly
 * `{ "level", "ts", "msg", "fields" }` (in that key order) so log shippers can parse it without
 * configuration. `fields` is the merge of the logger's base fields (accumulated through
 * `child()`) and the call-site fields, passed through `redactFields` so secrets never reach a
 * sink and so `Error` values, dates and cycles serialise safely. A logger never throws: a
 * failing sink is reported to `console.error` and swallowed.
 */
import { redactFields, redactString } from './redact'

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

export const DEFAULT_LOG_LEVEL: LogLevel = 'info'

/** Reported to `console.error` when a sink throws; the original call never fails. */
export const SINK_FAILURE_MESSAGE = '@earth/observability: log sink threw' as const
/** `fields` of a record whose fields could not be serialised; the message is still emitted. */
export const SERIALIZATION_FAILED_FIELDS: Readonly<Record<string, unknown>> = Object.freeze({
  serialization_failed: true,
})

export type LogFields = Readonly<Record<string, unknown>>

export interface LogRecord {
  readonly level: LogLevel
  /** ISO-8601 timestamp of the call. */
  readonly ts: string
  readonly msg: string
  /** Base + call fields, already redacted and JSON-safe. */
  readonly fields: Readonly<Record<string, unknown>>
}

/** Receives the formatted single-line JSON plus the structured record it was built from. */
export type LogSink = (line: string, record: LogRecord) => void

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** A logger sharing this sink and level whose records carry `fields` merged under call fields. */
  child(fields: LogFields): Logger
}

export interface CreateLoggerOptions {
  /** Defaults to a console sink routed by level. */
  readonly sink?: LogSink
  /** Minimum level emitted; defaults to `info`. */
  readonly level?: LogLevel
  /** Fields carried by every record (for example `{ app: 'earth-web', release }`). */
  readonly base?: LogFields
  /** Clock, injectable for tests. */
  readonly now?: () => Date
}

const LEVEL_SET: ReadonlySet<string> = new Set<string>(LOG_LEVELS)

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && LEVEL_SET.has(value)
}

/** Parses an environment-style value (`"WARN "` → `warn`), falling back when unrecognised. */
export function parseLogLevel(value: unknown, fallback: LogLevel = DEFAULT_LOG_LEVEL): LogLevel {
  if (typeof value !== 'string') return fallback
  const normalized = value.trim().toLowerCase()
  return isLogLevel(normalized) ? normalized : fallback
}

export function isLevelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[threshold]
}

/** Formats a record as single-line JSON with the canonical key order. */
export function formatLogRecord(record: LogRecord): string {
  const ordered = { level: record.level, ts: record.ts, msg: record.msg, fields: record.fields }
  try {
    return JSON.stringify(ordered)
  } catch {
    // `fields` are sanitised before reaching here, so this branch only guards a sink-supplied
    // record built by hand. Keep the line parseable rather than lose the message.
    return JSON.stringify({
      level: record.level,
      ts: record.ts,
      msg: record.msg,
      fields: SERIALIZATION_FAILED_FIELDS,
    })
  }
}

/** The subset of `console` a console sink needs; the global `console` satisfies it. */
export interface ConsoleLike {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** Writes each line through the console method matching its level. */
export function createConsoleSink(target: ConsoleLike = console): LogSink {
  return (line, record) => {
    target[record.level](line)
  }
}

export interface MemorySink {
  readonly sink: LogSink
  readonly records: LogRecord[]
  readonly lines: string[]
  clear(): void
}

/** A sink that keeps everything in memory; for tests and for surfacing logs in dev UIs. */
export function createMemorySink(): MemorySink {
  const records: LogRecord[] = []
  const lines: string[] = []
  return {
    records,
    lines,
    sink: (line, record) => {
      lines.push(line)
      records.push(record)
    },
    clear: () => {
      records.length = 0
      lines.length = 0
    },
  }
}

interface LoggerState {
  readonly sink: LogSink
  readonly threshold: LogLevel
  readonly now: () => Date
  readonly base: LogFields
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return buildLogger({
    sink: options.sink ?? createConsoleSink(),
    threshold: options.level ?? DEFAULT_LOG_LEVEL,
    now: options.now ?? (() => new Date()),
    base: options.base ?? {},
  })
}

function buildLogger(state: LoggerState): Logger {
  const emit = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (!isLevelEnabled(level, state.threshold)) return
    const record: LogRecord = {
      level,
      ts: state.now().toISOString(),
      msg: redactString(message),
      fields: safeRedactFields(state.base, fields),
    }
    const line = formatLogRecord(record)
    try {
      state.sink(line, record)
    } catch (sinkError) {
      reportSinkFailure(sinkError)
    }
  }
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
    child: (fields) => buildLogger({ ...state, base: { ...state.base, ...fields } }),
  }
}

/** `redactFields` never throws on plain data, but a proxy or getter can; the line still ships. */
function safeRedactFields(base: LogFields, fields: LogFields | undefined): LogRecord['fields'] {
  try {
    return redactFields({ ...base, ...fields })
  } catch {
    return SERIALIZATION_FAILED_FIELDS
  }
}

function reportSinkFailure(error: unknown): void {
  try {
    console.error(SINK_FAILURE_MESSAGE, error)
  } catch {
    // Nothing left to report to; a logger must never throw.
  }
}

/** A logger that discards everything; the default for tests and for tiers without a sink. */
export function createNoopLogger(): Logger {
  const noop = (): void => undefined
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger }
  return logger
}
