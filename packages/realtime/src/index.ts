/**
 * @earth/realtime — Conversation/room/presence channel helpers with polling fallback, LiveKit
 * connection helpers and RTC diagnostics emission (ARCHITECTURE §8; spec §53–§54, §57–§62,
 * §107–§109).
 *
 * Everything here is dependency-injected: supabase-js and livekit-client are described
 * structurally (`RealtimeClientLike`, `RoomLike`), time comes from a `RealtimeClock`, and
 * diagnostics go to a `RealtimeDiagnostics` emitter (`createRtcDiagnostics` from
 * `@earth/observability` satisfies it). Fakes for tests live under `@earth/realtime/testing`.
 */
export const PACKAGE_NAME = '@earth/realtime' as const

export * from './clock'
export * from './diagnostics'
export * from './channel'
export * from './conversation'
export * from './room'
export * from './presence'
export * from './livekit'
export * from './queue'
