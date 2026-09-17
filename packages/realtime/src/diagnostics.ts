/**
 * Diagnostics seam for this package (spec §14 "every realtime/video failure must emit diagnostic
 * data"; ARCHITECTURE §8).
 *
 * The event vocabulary — `RtcDiagnosticEvent`, `RTC_DIAGNOSTIC_KINDS`, the channel / permission /
 * track-source literals and the server-side `parseRtcDiagnosticEvent` — is owned by
 * `@earth/observability` and re-exported here unchanged, so there is exactly one definition of what
 * a diagnostic is. This module adds only what the emitting side needs: `RealtimeDiagnostics` (the
 * injected emitter; `createRtcDiagnostics(...)` from `@earth/observability` satisfies it, and so
 * does any `{ emit }` whose `emit` is sync or async), `noopDiagnostics` and `emitDiagnostic`.
 */
import type { RtcDiagnosticBase, RtcDiagnosticEvent, RtcDiagnosticKind } from '@earth/observability'

export {
  REALTIME_CHANNEL_KINDS,
  RTC_DIAGNOSTIC_KINDS,
  RTC_MEDIA_PERMISSIONS,
  RTC_TRACK_SOURCES,
  type RealtimeChannelKind,
  type RtcDiagnosticBase,
  type RtcDiagnosticEvent,
  type RtcDiagnosticKind,
  type RtcMediaPermission,
  type RtcTrackSource,
} from '@earth/observability'

/** Former name of `RtcDiagnosticEvent`; kept for existing importers, identical type. */
export type RealtimeDiagnosticEvent = RtcDiagnosticEvent
/** Former name of `RtcDiagnosticKind`; kept for existing importers, identical type. */
export type RealtimeDiagnosticKind = RtcDiagnosticKind
/** Former name of `RtcDiagnosticBase`; kept for existing importers, identical type. */
export type RealtimeDiagnosticBase = RtcDiagnosticBase

/**
 * The emitter this package needs. `createRtcDiagnostics(...)` from `@earth/observability`
 * satisfies it; its `emit` never rejects, and this package never awaits it.
 */
export interface RealtimeDiagnostics {
  emit(event: RtcDiagnosticEvent): unknown
}

/** Emits nothing; the default when an app does not wire diagnostics. */
export const noopDiagnostics: RealtimeDiagnostics = {
  emit: () => undefined,
}

/** Fires `emit` without awaiting it and without letting a throwing emitter break the call site. */
export function emitDiagnostic(diagnostics: RealtimeDiagnostics, event: RtcDiagnosticEvent): void {
  try {
    const result = diagnostics.emit(event)
    if (result instanceof Promise) {
      result.catch(() => undefined)
    }
  } catch {
    // Diagnostics are best effort.
  }
}
