/**
 * Provider and sink interfaces (spec §13 "analytics provider through a shared adapter";
 * ARCHITECTURE §2/§6).
 *
 * `AnalyticsProvider` is what clients and the server fan events out to (PostHog, console, noop,
 * first-party). `AnalyticsSink` is the server-side ingest dependency (`ServerDeps.analytics`,
 * ARCHITECTURE §6) that `POST /api/analytics/ingest` hands validated batches to. Providers receive
 * the fully merged property set: base + identity + event properties, all camelCase.
 */
import type { EventName } from './contract'
import type { AnalyticsIdentity } from './identity'
import type { AnalyticsEnvelope } from './ingest'

export type AnalyticsScalar = string | number | boolean | null
export type AnalyticsPropertyValue =
  AnalyticsScalar | undefined | readonly (string | number | boolean)[]
export type AnalyticsProperties = Readonly<Record<string, AnalyticsPropertyValue>>

export interface AnalyticsProvider {
  /** Stable adapter name for logs and error reports. */
  readonly name: string
  identify(identity: AnalyticsIdentity): void | Promise<void>
  capture(name: EventName, properties: AnalyticsProperties): void | Promise<void>
  /** Forget the current person (sign-out). Device-level ids are kept by the app, not the provider. */
  reset(): void | Promise<void>
  /** Deliver anything buffered. Optional for providers that send immediately. */
  flush?(): Promise<void>
}

export interface AnalyticsSinkContext {
  /** Identity the server derived from the bearer token, if any; wins over the batch's claim. */
  identity?: AnalyticsIdentity
  receivedAt: string
}

/** Server-side ingest (ARCHITECTURE §6 `ServerDeps.analytics`). */
export interface AnalyticsSink {
  ingest(events: readonly AnalyticsEnvelope[], context: AnalyticsSinkContext): Promise<void>
}
