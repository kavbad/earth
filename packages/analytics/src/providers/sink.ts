/**
 * Adapts an `AnalyticsSink` (server-side ingest, ARCHITECTURE §6) into an `AnalyticsProvider` so
 * server handlers can `track()` through the same client as apps do, writing straight to the
 * first-party store without an HTTP hop.
 */
import type { EventName } from '../contract'
import { type AnalyticsEnvelope, wireProperties } from '../ingest'
import type { AnalyticsProperties, AnalyticsProvider, AnalyticsSink } from '../provider'

export const SINK_PROVIDER_NAME = 'sink' as const

export interface SinkProviderOptions {
  sink: AnalyticsSink
  now?: () => number
}

export function createSinkProvider(options: SinkProviderOptions): AnalyticsProvider {
  const now = options.now ?? Date.now
  return {
    name: SINK_PROVIDER_NAME,
    identify: () => undefined,
    async capture(name: EventName, properties: AnalyticsProperties) {
      const envelope: AnalyticsEnvelope = { name, properties: wireProperties(properties) }
      await options.sink.ingest([envelope], { receivedAt: new Date(now()).toISOString() })
    },
    reset: () => undefined,
    flush: () => Promise.resolve(),
  }
}
