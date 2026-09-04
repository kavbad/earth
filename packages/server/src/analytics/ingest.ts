/**
 * `POST /api/analytics/ingest` (ARCHITECTURE §6; spec §13, PART XVI): the first-party event sink.
 * Batches are validated with `AnalyticsIngestBatchSchema` from `@earth/analytics` (unknown events,
 * GPS coordinates and oversized payloads are refused there), written to `analytics_events`
 * through `analytics_track(events)` as the caller (Visitors through the anon client; the RPC
 * applies its own rate limit and whitelist), and fanned out to `deps.analytics` (vendor sink).
 */
import { type AnalyticsEnvelope, AnalyticsIngestBatchSchema } from '@earth/analytics'
import { z } from 'zod'

import type { ServerDeps } from '../deps'
import { type EarthRequest, type EarthResponse, ok, optionalBearer, readBody, rpc } from '../http'

export const ANALYTICS_TRACK_RPC = 'analytics_track' as const
export const ANALYTICS_LOG = { sinkFailed: 'analytics.sink_failed' } as const

/** `analytics_track` returns the accepted count (or nothing); both are fine. */
export const AnalyticsTrackResultSchema = z.union([
  z.object({ accepted: z.int().min(0) }).transform((r) => r.accepted),
  z.int().min(0),
  z.null().transform(() => null),
  z.undefined().transform(() => null),
])

export interface AnalyticsIngestOutcome {
  readonly accepted: number
}

/** Events as the RPC receives them (`jsonb` array of `{ name, properties }`). */
export function toRpcEvents(events: readonly AnalyticsEnvelope[]): Record<string, unknown>[] {
  return events.map((event) => ({ name: event.name, properties: { ...event.properties } }))
}

export async function handleAnalyticsIngest(
  deps: ServerDeps,
  req: EarthRequest,
): Promise<EarthResponse> {
  const accessToken = optionalBearer(req)
  const batch = await readBody(req, AnalyticsIngestBatchSchema)
  const result = await rpc(
    deps,
    accessToken,
    ANALYTICS_TRACK_RPC,
    { events: toRpcEvents(batch.events) },
    AnalyticsTrackResultSchema,
  )
  const accepted = result ?? batch.events.length
  try {
    await deps.analytics.ingest(batch.events, { receivedAt: deps.now().toISOString() })
  } catch (cause) {
    // The first-party store already has the events; a vendor outage must not fail the client.
    deps.logger.warn(ANALYTICS_LOG.sinkFailed, { error: cause, events: batch.events.length })
  }
  const body: AnalyticsIngestOutcome = { accepted }
  return ok(body)
}
