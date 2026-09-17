/**
 * @earth/observability — ErrorMonitor interface, structured logger, RTC diagnostics and the
 * Sentry adapter (spec §14, §131; ARCHITECTURE §2, §6, §8).
 *
 * This package has no vendor dependency: `createSentryMonitor` takes a structurally-typed Sentry
 * SDK namespace by injection (see `./adapters/sentry`), so each app installs and initialises its
 * own `@sentry/*` package and passes it in. Every module is re-exported here; adapters can also be
 * imported by subpath (`@earth/observability/adapters/sentry`).
 */
export const PACKAGE_NAME = '@earth/observability' as const

export * from './redact'
export * from './logger'
export * from './monitor'
export * from './rtc'
export * from './adapters/sentry'
