/**
 * Fake LiveKit room: `connect` behaviour is scripted per attempt and tests emit SDK events.
 */
import {
  LIVEKIT_DISCONNECT_REASONS,
  type LiveKitRoomEvent,
  type LocalParticipantLike,
  type ParticipantLike,
  type RoomLike,
} from '../livekit'

export type FakeConnectOutcome = 'ok' | Error

export interface FakeRoom extends RoomLike {
  /** Outcome per connect attempt, consumed in order; `ok` once exhausted. */
  readonly connectOutcomes: FakeConnectOutcome[]
  readonly connectCalls: Array<{ url: string; token: string }>
  disconnectCalls: number
  connected: boolean
  /** Errors thrown by the next `setMicrophoneEnabled` / `setCameraEnabled`. */
  microphoneError: Error | null
  cameraError: Error | null
  readonly microphoneCalls: boolean[]
  readonly cameraCalls: boolean[]
  emit(event: LiveKitRoomEvent, ...args: unknown[]): void
  /** Simulates the SDK giving up (or a terminal reason). */
  drop(reason?: number): void
}

export function createFakeRoom(outcomes: FakeConnectOutcome[] = []): FakeRoom {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const localParticipant: LocalParticipantLike = {
    async setMicrophoneEnabled(enabled) {
      room.microphoneCalls.push(enabled)
      if (room.microphoneError !== null) throw room.microphoneError
      return undefined
    },
    async setCameraEnabled(enabled) {
      room.cameraCalls.push(enabled)
      if (room.cameraError !== null) throw room.cameraError
      return undefined
    },
  }
  const room: FakeRoom = {
    connectOutcomes: [...outcomes],
    connectCalls: [],
    disconnectCalls: 0,
    connected: false,
    microphoneError: null,
    cameraError: null,
    microphoneCalls: [],
    cameraCalls: [],
    localParticipant,
    async connect(url, token) {
      room.connectCalls.push({ url, token })
      const outcome = room.connectOutcomes.shift() ?? 'ok'
      if (outcome !== 'ok') throw outcome
      room.connected = true
      room.emit('connected')
    },
    async disconnect() {
      room.disconnectCalls += 1
      if (room.connected) {
        room.connected = false
        room.emit('disconnected', LIVEKIT_DISCONNECT_REASONS.CLIENT_INITIATED)
      }
    },
    on(event: string, listener: (...args: never[]) => unknown) {
      const list = listeners.get(event) ?? []
      list.push(listener as (...args: unknown[]) => void)
      listeners.set(event, list)
      return room
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    drop(reason = LIVEKIT_DISCONNECT_REASONS.UNKNOWN_REASON) {
      room.connected = false
      room.emit('disconnected', reason)
    },
  }
  return room
}

export function fakeParticipant(identity: string): ParticipantLike {
  return { identity }
}
