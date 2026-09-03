/**
 * RTC diagnostics (spec §14: every realtime/video failure emits diagnostic data; ARCHITECTURE
 * §8). Events from `@earth/realtime` are posted through the typed client (`POST
 * /api/diagnostics/rtc`) and echoed to the console in development. Never throws, never awaited.
 */
import { type EarthClient, RTC_DIAGNOSTIC_ENVELOPE_VERSION } from '@earth/api'
import type { RealtimeDiagnosticEvent, RealtimeDiagnostics } from '@earth/realtime'

export interface RtcDiagnosticsOptions {
  readonly earth: Pick<EarthClient, 'diagnostics'>
  readonly isDevelopment: boolean
  readonly now?: () => Date
  readonly log?: (message: string, ...details: unknown[]) => void
}

export function createRtcDiagnostics(options: RtcDiagnosticsOptions): RealtimeDiagnostics {
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((message, ...details) => console.debug(message, ...details))
  return {
    emit(event: RealtimeDiagnosticEvent) {
      if (options.isDevelopment) log('[earth rtc]', event.kind, event)
      options.earth.diagnostics
        .rtc({ v: RTC_DIAGNOSTIC_ENVELOPE_VERSION, ts: now().toISOString(), event: { ...event } })
        .catch(() => {
          // Diagnostics never take a room down.
        })
    },
  }
}
