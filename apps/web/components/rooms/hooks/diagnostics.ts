/**
 * RTC diagnostics for the web client (spec §14: every realtime/video failure emits diagnostic
 * data; ARCHITECTURE §8). Events from `@earth/realtime` are posted through the typed client
 * (`POST /api/diagnostics/rtc`) and echoed to the console in development. Never throws, never
 * awaited by callers.
 */
import { type EarthClient, RTC_DIAGNOSTIC_ENVELOPE_VERSION } from '@earth/api'
import type { RealtimeDiagnosticEvent, RealtimeDiagnostics } from '@earth/realtime'

export interface WebRtcDiagnosticsOptions {
  readonly earth: Pick<EarthClient, 'diagnostics'>
  readonly isDevelopment: boolean
  readonly now?: () => Date
}

export function createWebRtcDiagnostics(options: WebRtcDiagnosticsOptions): RealtimeDiagnostics {
  const now = options.now ?? (() => new Date())
  return {
    emit(event: RealtimeDiagnosticEvent) {
      if (options.isDevelopment) {
        console.debug('[earth rtc]', event.kind, event)
      }
      options.earth.diagnostics
        .rtc({ v: RTC_DIAGNOSTIC_ENVELOPE_VERSION, ts: now().toISOString(), event: { ...event } })
        .catch(() => {
          // Diagnostics never take a room down.
        })
    },
  }
}
