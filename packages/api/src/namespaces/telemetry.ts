/**
 * `analytics` and `diagnostics`: the first-party sinks of ARCHITECTURE §6. `@earth/analytics` and
 * `@earth/observability` own the full wire schemas and their own batching providers; these methods
 * exist for apps that route everything through `EarthClient`.
 */
import {
  type AnalyticsIngestBatchLike,
  AnalyticsIngestBatchSchema,
  type RtcDiagnosticEnvelopeLike,
  RtcDiagnosticEnvelopeSchema,
} from '../dto'
import { SERVER_ROUTES } from '../rpc'
import { type Transport, parseInput } from '../transport'

export interface AnalyticsNamespace {
  /** `POST /api/analytics/ingest`; anonymous when there is no session. */
  ingest(batch: AnalyticsIngestBatchLike): Promise<void>
}

export interface DiagnosticsNamespace {
  /** `POST /api/diagnostics/rtc`. */
  rtc(envelope: RtcDiagnosticEnvelopeLike): Promise<void>
}

export function createAnalyticsNamespace(transport: Transport): AnalyticsNamespace {
  return {
    ingest(batch) {
      const body = parseInput(AnalyticsIngestBatchSchema, batch)
      return transport.serverVoid({
        method: 'POST',
        path: SERVER_ROUTES.analyticsIngest,
        body,
        auth: 'optional',
      })
    },
  }
}

export function createDiagnosticsNamespace(transport: Transport): DiagnosticsNamespace {
  return {
    rtc(envelope) {
      const body = parseInput(RtcDiagnosticEnvelopeSchema, envelope)
      return transport.serverVoid({
        method: 'POST',
        path: SERVER_ROUTES.diagnosticsRtc,
        body,
        auth: 'optional',
      })
    },
  }
}
