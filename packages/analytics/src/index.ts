/**
 * @earth/analytics — AnalyticsProvider interface, typed event contract, PostHog + noop + first-party
 * adapters (ARCHITECTURE §2/§6, spec §13, PART XVI–XVII).
 *
 * No provider in this package imports a vendor SDK: the PostHog adapters take the app-constructed
 * SDK instance by injection (see `providers/posthog-common.ts`). Everything is also reachable by
 * subpath (`@earth/analytics/providers/posthog-web`, …) for apps that prefer narrow imports.
 */
export const PACKAGE_NAME = '@earth/analytics' as const

export * from './contract'
export * from './identity'
export * from './guard'
export * from './provider'
export * from './ingest'
export * from './client'
export * from './metrics'
export * from './providers/noop'
export * from './providers/console'
export * from './providers/first-party'
export * from './providers/sink'
export * from './providers/posthog-common'
export * from './providers/posthog-web'
export * from './providers/posthog-react-native'
export * from './providers/posthog-node'
