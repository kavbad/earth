/**
 * `createAnalytics` — the typed façade every app and the server tier use (spec §13, §96, §97).
 *
 * - `track(name, props)` is checked against `AnalyticsEventMap`, then merged as
 *   `{ ...base(), ...identity(), ...props }` (event properties win when they name the same key,
 *   e.g. `guest_removed.guestSessionId` is the removed Guest, not the moderator's session) and
 *   fanned out to every provider. A provider that throws or rejects never affects the others.
 * - Runtime guard: properties whose key names a coordinate (`lat`, `lng`, `latitude`, `longitude`,
 *   `coords`, …) throw `AnalyticsContractError` in development and are stripped in production.
 *   Unknown event names are treated the same way (throw / drop).
 */
import { type AnalyticsEventMap, type EventName, isEventName } from './contract'
import { findForbiddenPropertyKeys, stripForbiddenProperties } from './guard'
import { type AnalyticsIdentity, type BaseProperties, identityProperties } from './identity'
import type { AnalyticsProperties, AnalyticsProvider } from './provider'

export const FORBIDDEN_PROPERTY_MODES = ['throw', 'strip'] as const
export type ForbiddenPropertyMode = (typeof FORBIDDEN_PROPERTY_MODES)[number]

export const ANALYTICS_ERROR_CODES = ['forbidden_property', 'unknown_event'] as const
export type AnalyticsErrorCode = (typeof ANALYTICS_ERROR_CODES)[number]

export class AnalyticsContractError extends Error {
  override readonly name = 'AnalyticsContractError' as const
  readonly code: AnalyticsErrorCode
  readonly event: string
  readonly keys: readonly string[]

  constructor(code: AnalyticsErrorCode, event: string, keys: readonly string[] = []) {
    super(
      code === 'forbidden_property'
        ? `analytics event "${event}" carries forbidden GPS properties: ${keys.join(', ')}`
        : `analytics event "${event}" is not in the event contract`,
    )
    this.code = code
    this.event = event
    this.keys = keys
  }
}

export const ANALYTICS_OPERATIONS = ['identify', 'capture', 'reset', 'flush'] as const
export type AnalyticsOperation = (typeof ANALYTICS_OPERATIONS)[number]

export interface AnalyticsProviderFailure {
  provider: string
  operation: AnalyticsOperation
  event?: EventName
  error: unknown
}

export interface CreateAnalyticsOptions {
  providers: readonly AnalyticsProvider[]
  base: () => BaseProperties
  identity: () => AnalyticsIdentity
  /** Defaults to `throw` when {@link isDevelopmentRuntime} is true, otherwise `strip`. */
  onForbiddenProperty?: ForbiddenPropertyMode
  /** Provider failures are reported here (never thrown). Defaults to silence. */
  onError?: (failure: AnalyticsProviderFailure) => void
}

export interface AnalyticsClient {
  track<E extends EventName>(name: E, properties: AnalyticsEventMap[E]): void
  /** Sends the current (or given) identity to every provider. */
  identify(identity?: AnalyticsIdentity): void
  reset(): void
  flush(): Promise<void>
  readonly providers: readonly AnalyticsProvider[]
}

/** `__DEV__` (React Native) or `NODE_ENV !== 'production'` (Node / bundlers). */
export function isDevelopmentRuntime(): boolean {
  const dev = (globalThis as { __DEV__?: unknown }).__DEV__
  if (typeof dev === 'boolean') return dev
  const env = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env
  if (env !== undefined && typeof env.NODE_ENV === 'string') return env.NODE_ENV !== 'production'
  return false
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** Merges base, identity and event properties in that precedence (event properties win). */
export function mergeEventProperties(
  base: BaseProperties,
  identity: AnalyticsIdentity,
  properties: Readonly<Record<string, unknown>>,
): AnalyticsProperties {
  const merged: Record<string, unknown> = { ...base, ...identityProperties(identity) }
  for (const [key, value] of Object.entries(properties)) {
    if (value !== undefined) merged[key] = value
  }
  return merged as AnalyticsProperties
}

export function createAnalytics(options: CreateAnalyticsOptions): AnalyticsClient {
  const providers = [...options.providers]
  const mode: ForbiddenPropertyMode =
    options.onForbiddenProperty ?? (isDevelopmentRuntime() ? 'throw' : 'strip')
  const onError = options.onError ?? (() => undefined)

  const report = (
    provider: AnalyticsProvider,
    operation: AnalyticsOperation,
    error: unknown,
    event?: EventName,
  ): void => {
    const failure: AnalyticsProviderFailure =
      event === undefined
        ? { provider: provider.name, operation, error }
        : { provider: provider.name, operation, event, error }
    try {
      onError(failure)
    } catch {
      // A broken error handler must not take the app down either.
    }
  }

  const run = (
    provider: AnalyticsProvider,
    operation: AnalyticsOperation,
    action: () => void | Promise<void>,
    event?: EventName,
  ): Promise<void> => {
    try {
      const result: unknown = action()
      // Duck-type rather than `instanceof Promise`: SDKs may return a thenable from another realm
      // or a custom promise class, and an unobserved rejection there would surface as an
      // unhandled rejection instead of an `onError` report.
      return isThenable(result)
        ? Promise.resolve(result).then(
            () => undefined,
            (error: unknown) => report(provider, operation, error, event),
          )
        : Promise.resolve()
    } catch (error) {
      report(provider, operation, error, event)
      return Promise.resolve()
    }
  }

  const prepare = (
    name: string,
    properties: Readonly<Record<string, unknown>>,
  ): AnalyticsProperties | undefined => {
    if (!isEventName(name)) {
      if (mode === 'throw') throw new AnalyticsContractError('unknown_event', name)
      return undefined
    }
    const merged = mergeEventProperties(options.base(), options.identity(), properties)
    const forbidden = findForbiddenPropertyKeys(merged)
    if (forbidden.length === 0) return merged
    if (mode === 'throw') throw new AnalyticsContractError('forbidden_property', name, forbidden)
    return stripForbiddenProperties(merged)
  }

  return {
    providers,
    track(name, properties) {
      const merged = prepare(name, properties)
      if (merged === undefined) return
      for (const provider of providers) {
        void run(provider, 'capture', () => provider.capture(name, merged), name)
      }
    },
    identify(identity) {
      const resolved = identity ?? options.identity()
      for (const provider of providers) {
        void run(provider, 'identify', () => provider.identify(resolved))
      }
    },
    reset() {
      for (const provider of providers) {
        void run(provider, 'reset', () => provider.reset())
      }
    },
    async flush() {
      await Promise.all(
        providers.map((provider) =>
          provider.flush === undefined
            ? Promise.resolve()
            : run(provider, 'flush', () => provider.flush?.()),
        ),
      )
    },
  }
}
