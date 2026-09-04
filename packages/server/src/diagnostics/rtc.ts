/**
 * `POST /api/diagnostics/rtc` (ARCHITECTURE §6, §8; spec §14): the RTC diagnostics sink. The
 * envelope is validated by `parseRtcDiagnosticEnvelope` from `@earth/observability` (only known
 * kinds and fields survive; free text is scrubbed) and stored through `rtc_diagnostic_record`
 * as the caller so the database can attribute it to the Human or Guest session (DB_API §8).
 */
import { EarthError } from '@earth/domain'
import { parseRtcDiagnosticEnvelope } from '@earth/observability'

import type { ServerDeps } from '../deps'
import {
  AnyRpcResultSchema,
  type EarthRequest,
  type EarthResponse,
  ok,
  optionalBearer,
  readJson,
  rpc,
} from '../http'

export const RTC_DIAGNOSTIC_RECORD_RPC = 'rtc_diagnostic_record' as const

export interface RtcDiagnosticsOutcome {
  readonly ok: true
  readonly kind: string
}

export async function handleRtcDiagnostics(
  deps: ServerDeps,
  req: EarthRequest,
): Promise<EarthResponse> {
  const accessToken = optionalBearer(req)
  const envelope = parseRtcDiagnosticEnvelope(await readJson(req))
  if (envelope === null) {
    throw new EarthError('invalid_input', {
      details: { field: 'body', reason: 'not_an_rtc_envelope' },
    })
  }
  const { kind, roomId, ...rest } = envelope.event
  await rpc(
    deps,
    accessToken,
    RTC_DIAGNOSTIC_RECORD_RPC,
    {
      kind,
      room_id: roomId ?? null,
      payload: { ...rest, ts: envelope.ts, receivedAt: deps.now().toISOString() },
    },
    AnyRpcResultSchema,
  )
  const body: RtcDiagnosticsOutcome = { ok: true, kind }
  return ok(body)
}
