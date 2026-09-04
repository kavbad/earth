/**
 * Sentry adapter for `ErrorMonitor`.
 *
 * ## Injection design
 *
 * Earth runs three Sentry SDKs — `@sentry/react-native` (apps/mobile), `@sentry/nextjs`
 * (apps/web) and `@sentry/node` (server tier) — that share one public surface but have
 * incompatible package types and platform-specific initialisation. This package therefore has
 * **no Sentry dependency**: `createSentryMonitor` accepts any object that structurally satisfies
 * `SentryLike` (the five functions every SDK exports: `captureException`, `captureMessage`,
 * `setUser`, `addBreadcrumb`, `flush`, plus the optional `setTag`). Each app initialises its own
 * SDK and passes the namespace in:
 *
 * ```ts
 * import * as Sentry from '@sentry/nextjs'
 * Sentry.init({ dsn, release: buildRelease({ app: 'earth-web', version, commit }) })
 * const monitor = createSentryMonitor(Sentry, { release })
 * ```
 *
 * `SentryLike` uses method syntax on purpose: TypeScript checks method parameters bivariantly, so
 * the real SDK namespaces (whose parameter types are wider unions) are assignable without this
 * package importing them. Tests exercise the adapter with a fake that has the same shape.
 *
 * ## Redaction
 *
 * Sentry is a third party, so everything this adapter forwards goes through `../redact` first:
 * `extra`, breadcrumb `data` and messages are scrubbed of secret keys and secret-shaped strings,
 * and tags under a secret key are replaced. The SDK serialises the exception's own `message` and
 * `stack`, so `scrubException` hands it a copy with those scrubbed whenever they contain a secret
 * (the original error is never mutated, and a clean error is forwarded as-is). `cause` chains are
 * left to Sentry's default server-side data scrubbing, which apps keep enabled.
 *
 * ## Release tracking (spec §14)
 *
 * Sentry fixes `release` at `init`; it cannot be changed afterwards. `buildRelease` produces the
 * canonical `app@version+commit` name the apps pass to `init`, and `setRelease` records the same
 * value as the `earth.release` tag so events can be cross-checked against what the app believes
 * it is running.
 */
import {
  type Breadcrumb,
  type ErrorMonitor,
  type MonitorContext,
  type MonitorIdentity,
  type MonitorSeverity,
  type MonitorTagValue,
  type MonitorTags,
  DEFAULT_MESSAGE_SEVERITY,
  enrichContextForError,
} from '../monitor'
import { REDACTED_VALUE, isRedactedKey, redactFields, redactString } from '../redact'

/** Sentry's `SeverityLevel` is a superset (`'log'` too); ours is assignable to it. */
export type SentrySeverityLevel = MonitorSeverity

export interface SentryScopeContext {
  level?: SentrySeverityLevel | undefined
  tags?: Record<string, string | number | boolean> | undefined
  extra?: Record<string, unknown> | undefined
  fingerprint?: string[] | undefined
}

export interface SentryUser {
  id: string
  username?: string | undefined
  [key: string]: unknown
}

export interface SentryBreadcrumb {
  category?: string | undefined
  message?: string | undefined
  level?: SentrySeverityLevel | undefined
  data?: Record<string, unknown> | undefined
  /** Seconds since epoch (Sentry convention). */
  timestamp?: number | undefined
}

/** Structural subset of a Sentry SDK namespace. Return types are `unknown` so any SDK version fits. */
export interface SentryLike {
  captureException(exception: unknown, captureContext?: SentryScopeContext): unknown
  captureMessage(
    message: string,
    captureContext?: SentryScopeContext | SentrySeverityLevel,
  ): unknown
  setUser(user: SentryUser | null): unknown
  addBreadcrumb(breadcrumb: SentryBreadcrumb): unknown
  setTag?(key: string, value: string): unknown
  flush?(timeout?: number): Promise<boolean>
}

/** Tag recorded by `setRelease` (Sentry's own `release` attribute is fixed at `init`). */
export const SENTRY_RELEASE_TAG = 'earth.release' as const
/** Extra key on the Sentry user carrying `MonitorIdentity.kind` (`human` | `guest`). */
export const SENTRY_IDENTITY_KIND_KEY = 'earth_kind' as const

export interface SentryMonitorOptions {
  /** Applied through `setRelease` at creation; pass the same value given to `Sentry.init`. */
  readonly release?: string
  readonly now?: () => Date
}

const MILLISECONDS_PER_SECOND = 1000

/** Drops `undefined` members so the SDK receives only the fields we actually set. */
function defined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, member] of Object.entries(value)) {
    if (member !== undefined) out[key] = member
  }
  // Same keys minus the undefined ones; every property of T already admits `undefined`.
  return out as T
}

/** Tags are indexed as-is by Sentry, so a tag under a secret key is replaced rather than dropped. */
export function redactTags(tags: MonitorTags): Record<string, MonitorTagValue> {
  const out: Record<string, MonitorTagValue> = {}
  for (const [key, value] of Object.entries(tags)) {
    out[key] = isRedactedKey(key) ? REDACTED_VALUE : value
  }
  return out
}

export function toSentryScopeContext(
  context: MonitorContext | undefined,
  level?: MonitorSeverity,
): SentryScopeContext | undefined {
  if (context === undefined && level === undefined) return undefined
  return defined<SentryScopeContext>({
    level,
    tags: context?.tags === undefined ? undefined : redactTags(context.tags),
    extra: context?.extra === undefined ? undefined : redactFields(context.extra),
    fingerprint: context?.fingerprint === undefined ? undefined : [...context.fingerprint],
  })
}

export function toSentryUser(identity: MonitorIdentity | null): SentryUser | null {
  if (identity === null) return null
  const user: SentryUser = { id: identity.id, [SENTRY_IDENTITY_KIND_KEY]: identity.kind }
  if (identity.kind === 'human' && identity.handle !== undefined) user.username = identity.handle
  return user
}

export function toSentryBreadcrumb(crumb: Breadcrumb, now: () => Date): SentryBreadcrumb {
  return defined<SentryBreadcrumb>({
    category: crumb.category,
    message: crumb.message,
    level: crumb.level,
    data: crumb.data === undefined ? undefined : redactFields(crumb.data),
    timestamp: (crumb.timestampMs ?? now().getTime()) / MILLISECONDS_PER_SECOND,
  })
}

/**
 * The error to hand to `Sentry.captureException`: the original when its message and stack are
 * clean, otherwise a same-prototype copy carrying scrubbed ones (own properties such as `code`,
 * `details` and `cause` are copied so grouping and enrichment still work).
 */
export function scrubException(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const message = redactString(error.message)
  const stack = typeof error.stack === 'string' ? redactString(error.stack) : undefined
  if (message === error.message && stack === error.stack) return error
  const copy = Object.create(Object.getPrototypeOf(error) as object | null) as Error
  Object.defineProperties(copy, Object.getOwnPropertyDescriptors(error))
  Object.defineProperty(copy, 'message', {
    value: message,
    writable: true,
    configurable: true,
    enumerable: false,
  })
  if (stack !== undefined) {
    Object.defineProperty(copy, 'stack', {
      value: stack,
      writable: true,
      configurable: true,
      enumerable: false,
    })
  }
  return copy
}

export function createSentryMonitor(
  sentry: SentryLike,
  options: SentryMonitorOptions = {},
): ErrorMonitor {
  const now = options.now ?? (() => new Date())
  const monitor: ErrorMonitor = {
    captureException(error, context) {
      sentry.captureException(
        scrubException(error),
        toSentryScopeContext(enrichContextForError(error, context)),
      )
    },
    captureMessage(message, level = DEFAULT_MESSAGE_SEVERITY, context) {
      sentry.captureMessage(redactString(message), toSentryScopeContext(context, level))
    },
    setUser(identity) {
      sentry.setUser(toSentryUser(identity))
    },
    setRelease(release) {
      sentry.setTag?.(SENTRY_RELEASE_TAG, release)
    },
    addBreadcrumb(crumb) {
      sentry.addBreadcrumb(toSentryBreadcrumb(crumb, now))
    },
    flush(timeoutMs) {
      return sentry.flush === undefined ? Promise.resolve(true) : sentry.flush(timeoutMs)
    },
  }
  if (options.release !== undefined) monitor.setRelease(options.release)
  return monitor
}

// ---------------------------------------------------------------------------------------------
// Release naming
// ---------------------------------------------------------------------------------------------

export interface ReleaseParts {
  /** Package name: `earth-mobile`, `earth-web`, `earth-server`. */
  readonly app: string
  /** Semantic version of the app (`1.4.0`, `1.4.0-preview.2`). */
  readonly version: string
  /** Git commit SHA (7–40 hex chars); omitted for local builds without one. */
  readonly commit?: string
}

export const RELEASE_APP_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i
export const RELEASE_VERSION_PATTERN = /^[0-9a-z][0-9a-z.-]*$/i
export const RELEASE_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i
/** Sentry rejects longer release names. */
export const RELEASE_MAX_LENGTH = 200

const RELEASE_VERSION_SEPARATOR = '@' as const
const RELEASE_COMMIT_SEPARATOR = '+' as const

export class ReleaseFormatError extends TypeError {
  override readonly name = 'ReleaseFormatError' as const
}

/**
 * Builds the Sentry release name `app@version+commit` (Sentry's `package@version+build`
 * convention) shared by `Sentry.init`, `setRelease` and the `release` base field of loggers.
 */
export function buildRelease(parts: ReleaseParts): string {
  const app = parts.app.trim()
  const version = parts.version.trim()
  if (!RELEASE_APP_PATTERN.test(app))
    throw new ReleaseFormatError(`invalid release app: ${parts.app}`)
  if (!RELEASE_VERSION_PATTERN.test(version)) {
    throw new ReleaseFormatError(`invalid release version: ${parts.version}`)
  }
  let release = `${app}${RELEASE_VERSION_SEPARATOR}${version}`
  if (parts.commit !== undefined) {
    const commit = parts.commit.trim().toLowerCase()
    if (!RELEASE_COMMIT_PATTERN.test(commit)) {
      throw new ReleaseFormatError(`invalid release commit: ${parts.commit}`)
    }
    release = `${release}${RELEASE_COMMIT_SEPARATOR}${commit}`
  }
  if (release.length > RELEASE_MAX_LENGTH) {
    throw new ReleaseFormatError(`release longer than ${RELEASE_MAX_LENGTH}: ${release}`)
  }
  return release
}

/** Inverse of `buildRelease`; `null` when the string is not a release this package produced. */
export function parseRelease(release: string): ReleaseParts | null {
  const at = release.indexOf(RELEASE_VERSION_SEPARATOR)
  if (at <= 0) return null
  const app = release.slice(0, at)
  const rest = release.slice(at + 1)
  const plus = rest.indexOf(RELEASE_COMMIT_SEPARATOR)
  const version = plus === -1 ? rest : rest.slice(0, plus)
  const commit = plus === -1 ? undefined : rest.slice(plus + 1)
  if (!RELEASE_APP_PATTERN.test(app) || !RELEASE_VERSION_PATTERN.test(version)) return null
  if (commit === undefined) return { app, version }
  if (!RELEASE_COMMIT_PATTERN.test(commit)) return null
  return { app, version, commit }
}
