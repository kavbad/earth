/**
 * Which error monitor the app reports to (spec §14; ARCHITECTURE §2): Sentry through the
 * `@earth/observability` adapter when `EXPO_PUBLIC_SENTRY_DSN` is set and the SDK initialised,
 * the structured console in development otherwise, noop in production without a DSN. Pure
 * selection so it is unit-tested; the SDK namespace is injected by `./monitor.ts`.
 */
import type { HumanId } from '@earth/domain'
import {
  type ErrorMonitor,
  type Logger,
  type MonitorIdentity,
  type SentryLike,
  buildRelease,
  createConsoleMonitor,
  createLogger,
  createNoopMonitor,
  createSentryMonitor,
} from '@earth/observability'

export const MOBILE_RELEASE_APP = 'earth-mobile' as const

/** `earth-mobile@0.1.0` (`+commit` when a build knows it): the release given to `Sentry.init`. */
export function mobileRelease(version: string, commit?: string): string {
  return buildRelease(
    commit === undefined
      ? { app: MOBILE_RELEASE_APP, version }
      : { app: MOBILE_RELEASE_APP, version, commit },
  )
}

export interface SelectMonitorInput {
  readonly dsn: string | undefined
  /** The initialised `@sentry/react-native` namespace, or `null` when there is no DSN. */
  readonly sentry: SentryLike | null
  readonly release: string
  readonly isDevelopment: boolean
  /** Logger behind the development monitor (defaults to the console). */
  readonly logger?: Logger
}

export function selectErrorMonitor(input: SelectMonitorInput): ErrorMonitor {
  if (input.dsn !== undefined && input.sentry !== null) {
    return createSentryMonitor(input.sentry, { release: input.release })
  }
  if (input.isDevelopment) {
    const logger = input.logger ?? createLogger({ base: { app: MOBILE_RELEASE_APP } })
    const monitor = createConsoleMonitor(logger)
    monitor.setRelease(input.release)
    return monitor
  }
  return createNoopMonitor()
}

export interface MonitorSessionLike {
  readonly humanId: HumanId | null
  readonly identity: { readonly handle: string } | null
}

/** Humans are known by id and public handle only (never email or phone); everyone else is nobody. */
export function monitorIdentityFor(session: MonitorSessionLike): MonitorIdentity | null {
  if (session.humanId === null) return null
  const handle = session.identity?.handle
  return handle === undefined
    ? { kind: 'human', id: session.humanId }
    : { kind: 'human', id: session.humanId, handle }
}
