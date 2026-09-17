import { asRoomId } from '@earth/domain'
import type { Room } from 'livekit-client'
import { describe, expect, it, vi } from 'vitest'

import {
  type ConnectLiveKitOptions,
  DEFAULT_RECONNECT_POLICY,
  LIVEKIT_DISCONNECT_REASONS,
  LIVEKIT_SUBSCRIPTION_ERRORS,
  type LiveKitConnectionState,
  type LiveKitStateDetail,
  type RoomLike,
  connectLiveKit,
  disconnectReasonName,
  isPermissionDeniedError,
  isRetryableDisconnect,
  NETWORK_UNAVAILABLE_REASON,
  subscriptionErrorName,
} from './livekit'
import { type FakeClock, createFakeClock, flushPromises } from './testing/fake-clock'
import {
  type FakeConnectOutcome,
  type FakeRoom,
  createFakeRoom,
  fakeParticipant,
} from './testing/fake-room'
import { createRecordingDiagnostics } from './testing/fakes'

/** Compile-time check: livekit-client's `Room` satisfies the structural interface. */
const _roomIsRoomLike: (room: Room) => RoomLike = (room) => room

const ROOM_ID = asRoomId('55555555-5555-4555-8555-555555555555')
const URL = 'wss://livekit.example'
const TOKEN = 'token'

function permissionError(): Error {
  const error = new Error('Permission denied')
  error.name = 'NotAllowedError'
  return error
}

function setup(
  outcomes: FakeConnectOutcome[] = [],
  overrides: Partial<ConnectLiveKitOptions> = {},
  prepareRoom: (room: FakeRoom, clock: FakeClock) => void = () => undefined,
) {
  const clock = createFakeClock()
  const diagnostics = createRecordingDiagnostics()
  const room = createFakeRoom(outcomes)
  prepareRoom(room, clock)
  const states: Array<[LiveKitConnectionState, LiveKitStateDetail]> = []
  const onQuality = vi.fn()
  const connection = connectLiveKit({
    createRoom: () => room,
    url: URL,
    token: TOKEN,
    roomId: ROOM_ID,
    onState: (state, detail) => states.push([state, detail]),
    onQuality,
    diagnostics,
    clock,
    ...overrides,
  })
  return { clock, diagnostics, room, states, onQuality, connection }
}

describe('helpers', () => {
  it('names disconnect reasons and classifies them', () => {
    expect(disconnectReasonName(LIVEKIT_DISCONNECT_REASONS.PARTICIPANT_REMOVED)).toBe(
      'PARTICIPANT_REMOVED',
    )
    expect(disconnectReasonName(99)).toBeUndefined()
    expect(disconnectReasonName('x')).toBeUndefined()
    expect(isRetryableDisconnect(LIVEKIT_DISCONNECT_REASONS.SIGNAL_CLOSE)).toBe(true)
    expect(isRetryableDisconnect(LIVEKIT_DISCONNECT_REASONS.DUPLICATE_IDENTITY)).toBe(false)
    expect(isRetryableDisconnect(undefined)).toBe(true)
  })

  it('names subscription errors', () => {
    expect(subscriptionErrorName(LIVEKIT_SUBSCRIPTION_ERRORS.SE_CODEC_UNSUPPORTED)).toBe(
      'SE_CODEC_UNSUPPORTED',
    )
    expect(subscriptionErrorName(42)).toBeUndefined()
    expect(subscriptionErrorName(undefined)).toBeUndefined()
  })

  it('detects permission errors by name or message', () => {
    expect(isPermissionDeniedError(permissionError())).toBe(true)
    expect(isPermissionDeniedError(new Error('permission denied by OS'))).toBe(true)
    expect(isPermissionDeniedError(new Error('device busy'))).toBe(false)
    expect(isPermissionDeniedError(null)).toBe(false)
  })

  it('defaults to the domain reconnect policy', () => {
    expect(DEFAULT_RECONNECT_POLICY).toEqual({
      attempts: 5,
      backoffMs: [500, 1000, 2000, 4000, 8000],
    })
  })
})

describe('connectLiveKit — connecting', () => {
  it('connects on the first attempt and reports durations', async () => {
    const { diagnostics, room, states, connection } = setup([], {}, (fakeRoom, fakeClock) => {
      const original = fakeRoom.connect.bind(fakeRoom)
      fakeRoom.connect = async (url, token) => {
        fakeClock.advance(250)
        await original(url, token)
      }
    })
    expect(connection.state()).toBe('connecting')
    await expect(connection.settled()).resolves.toBe('connected')
    expect(room.connectCalls).toEqual([{ url: URL, token: TOKEN }])
    expect(states).toEqual([
      ['connecting', { attempt: 1 }],
      ['connected', { attempt: 1 }],
    ])
    expect(diagnostics.events).toEqual([
      { kind: 'connect_attempt', roomId: ROOM_ID, attempt: 1 },
      { kind: 'connected', roomId: ROOM_ID, attempt: 1, durationMs: 250 },
    ])
    expect(connection.flipCamera).toBeUndefined()
  })

  it('retries the initial connect with backoff', async () => {
    const { clock, room, states, connection } = setup([new Error('net'), new Error('net')])
    await flushPromises()
    expect(connection.state()).toBe('connecting')
    expect(clock.nextDelay()).toBe(500)
    await clock.advanceAsync(500)
    expect(room.connectCalls).toHaveLength(2)
    expect(clock.nextDelay()).toBe(1_000)
    await clock.advanceAsync(1_000)
    await expect(connection.settled()).resolves.toBe('connected')
    expect(room.connectCalls).toHaveLength(3)
    expect(states.map(([s, d]) => [s, d.attempt])).toEqual([
      ['connecting', 1],
      ['connecting', 2],
      ['connecting', 3],
      ['connected', 3],
    ])
  })

  it('fails after exhausting the policy and lets "Try again" reconnect', async () => {
    const { clock, diagnostics, room, states, connection } = setup(
      Array.from({ length: 5 }, () => new Error('net')),
    )
    for (const backoff of [500, 1_000, 2_000, 4_000]) {
      await flushPromises()
      expect(clock.nextDelay()).toBe(backoff)
      await clock.advanceAsync(backoff)
    }
    await expect(connection.settled()).resolves.toBe('failed')
    expect(room.connectCalls).toHaveLength(5)
    expect(states.at(-1)).toEqual(['failed', { attempt: 5, reason: 'net' }])
    expect(diagnostics.events.at(-1)).toEqual({
      kind: 'connect_failed',
      roomId: ROOM_ID,
      attempt: 5,
      durationMs: 7_500,
      reason: 'net',
    })
    expect(diagnostics.kinds().filter((k) => k === 'connect_attempt')).toHaveLength(5)

    await expect(connection.retry()).resolves.toBe('connected')
    expect(room.connectCalls).toHaveLength(6)
    expect(states.slice(-2)).toEqual([
      ['connecting', { attempt: 1 }],
      ['connected', { attempt: 1 }],
    ])
    // Retry is a no-op while connected.
    await expect(connection.retry()).resolves.toBe('connected')
    expect(room.connectCalls).toHaveLength(6)
  })
})

describe('connectLiveKit — offline (spec §107)', () => {
  it('skips attempts while offline, emits network_unavailable and fails with that reason', async () => {
    const network = { online: false }
    const { clock, diagnostics, room, states, connection } = setup([], {
      isOnline: () => network.online,
    })
    for (const backoff of [500, 1_000, 2_000, 4_000]) {
      await flushPromises()
      expect(clock.nextDelay()).toBe(backoff)
      await clock.advanceAsync(backoff)
    }
    await expect(connection.settled()).resolves.toBe('failed')
    expect(room.connectCalls).toHaveLength(0)
    expect(states.at(-1)).toEqual([
      'failed',
      { attempt: 5, reason: NETWORK_UNAVAILABLE_REASON, code: NETWORK_UNAVAILABLE_REASON },
    ])
    expect(diagnostics.kinds().filter((k) => k === 'network_unavailable')).toHaveLength(5)
    expect(diagnostics.events[1]).toEqual({
      kind: 'network_unavailable',
      roomId: ROOM_ID,
      attempt: 1,
      code: NETWORK_UNAVAILABLE_REASON,
    })
    expect(diagnostics.events.at(-1)).toEqual({
      kind: 'connect_failed',
      roomId: ROOM_ID,
      attempt: 5,
      durationMs: 7_500,
      reason: NETWORK_UNAVAILABLE_REASON,
      code: NETWORK_UNAVAILABLE_REASON,
    })
    // Back online: "Try again" connects on the first attempt.
    network.online = true
    await expect(connection.retry()).resolves.toBe('connected')
    expect(room.connectCalls).toHaveLength(1)
  })

  it('connects as soon as the network returns within the policy', async () => {
    const network = { online: false }
    const { clock, room, connection } = setup([], { isOnline: () => network.online })
    await flushPromises()
    await clock.advanceAsync(500)
    expect(room.connectCalls).toHaveLength(0)
    network.online = true
    await clock.advanceAsync(1_000)
    await expect(connection.settled()).resolves.toBe('connected')
    expect(room.connectCalls).toHaveLength(1)
  })
})

describe('connectLiveKit — SDK reconnects', () => {
  it('mirrors reconnecting / reconnected with the time the drop took', async () => {
    const { clock, diagnostics, room, states, connection } = setup()
    await connection.settled()
    room.emit('reconnecting')
    expect(connection.state()).toBe('reconnecting')
    room.emit('reconnecting')
    clock.advance(1_200)
    room.emit('reconnected')
    expect(connection.state()).toBe('connected')
    expect(states.slice(2)).toEqual([
      ['reconnecting', { attempt: 1 }],
      ['reconnecting', { attempt: 2 }],
      ['connected', { attempt: 2 }],
    ])
    expect(diagnostics.events.slice(2)).toEqual([
      { kind: 'reconnecting', roomId: ROOM_ID, attempt: 1 },
      { kind: 'reconnecting', roomId: ROOM_ID, attempt: 2 },
      { kind: 'connected', roomId: ROOM_ID, attempt: 2, durationMs: 1_200 },
    ])
  })

  it('counts the time the SDK spent reconnecting into its own reconnect loop', async () => {
    const { clock, diagnostics, room, connection } = setup()
    await connection.settled()
    room.emit('reconnecting')
    clock.advance(3_000)
    room.connectOutcomes.push(new Error('signal'))
    room.drop(LIVEKIT_DISCONNECT_REASONS.SIGNAL_CLOSE)
    await clock.advanceAsync(500)
    await clock.advanceAsync(1_000)
    await expect(connection.settled()).resolves.toBe('connected')
    expect(diagnostics.events.at(-1)).toEqual({
      kind: 'connected',
      roomId: ROOM_ID,
      attempt: 2,
      durationMs: 4_500,
    })
  })

  it('reports connection quality for the participant', async () => {
    const { room, onQuality, connection } = setup()
    await connection.settled()
    room.emit('connectionQualityChanged', 'poor', fakeParticipant('h:abc'))
    room.emit('connectionQualityChanged', 'weird', fakeParticipant('g:def'))
    expect(onQuality.mock.calls).toEqual([
      ['poor', 'h:abc'],
      ['unknown', 'g:def'],
    ])
  })
})

describe('connectLiveKit — drops', () => {
  it('runs its own reconnect loop when the SDK gives up, then fails', async () => {
    const { clock, diagnostics, room, states, connection } = setup()
    await connection.settled()
    room.connectOutcomes.push(...Array.from({ length: 5 }, () => new Error('signal')))
    room.drop(LIVEKIT_DISCONNECT_REASONS.SIGNAL_CLOSE)
    expect(connection.state()).toBe('reconnecting')
    for (const backoff of [500, 1_000, 2_000, 4_000, 8_000]) {
      await flushPromises()
      expect(clock.nextDelay()).toBe(backoff)
      await clock.advanceAsync(backoff)
    }
    await expect(connection.settled()).resolves.toBe('failed')
    expect(room.connectCalls).toHaveLength(6)
    expect(states.slice(2).map(([s, d]) => [s, d.attempt])).toEqual([
      ['reconnecting', 1],
      ['reconnecting', 2],
      ['reconnecting', 3],
      ['reconnecting', 4],
      ['reconnecting', 5],
      ['failed', 5],
    ])
    expect(diagnostics.events.at(-1)).toEqual({
      kind: 'reconnect_failed',
      roomId: ROOM_ID,
      attempt: 5,
      durationMs: 15_500,
      reason: 'signal',
    })
    // "Try again" from failed.
    await expect(connection.retry()).resolves.toBe('connected')
    expect(diagnostics.kinds().slice(-2)).toEqual(['connect_attempt', 'connected'])
  })

  it('recovers within the loop', async () => {
    const { clock, room, connection } = setup()
    await connection.settled()
    room.connectOutcomes.push(new Error('signal'))
    room.drop()
    await clock.advanceAsync(500)
    expect(connection.state()).toBe('reconnecting')
    await clock.advanceAsync(1_000)
    await expect(connection.settled()).resolves.toBe('connected')
    expect(room.connectCalls).toHaveLength(3)
  })

  it('retry is a no-op while reconnecting and disconnect cancels the backoff timer', async () => {
    const { clock, room, connection } = setup()
    await connection.settled()
    room.connectOutcomes.push(new Error('signal'))
    room.drop(LIVEKIT_DISCONNECT_REASONS.SIGNAL_CLOSE)
    await flushPromises()
    expect(connection.state()).toBe('reconnecting')
    const settled = connection.settled()
    expect(connection.retry()).toBe(settled)
    expect(clock.pending()).toBe(1)
    await connection.disconnect()
    expect(clock.pending()).toBe(0)
    expect(connection.state()).toBe('disconnected')
    await clock.advanceAsync(60_000)
    expect(room.connectCalls).toHaveLength(1)
  })

  it('treats terminal reasons as a clean disconnect', async () => {
    const { clock, diagnostics, room, states, connection } = setup()
    await connection.settled()
    room.drop(LIVEKIT_DISCONNECT_REASONS.PARTICIPANT_REMOVED)
    expect(connection.state()).toBe('disconnected')
    expect(states.at(-1)).toEqual(['disconnected', { code: 'PARTICIPANT_REMOVED' }])
    expect(diagnostics.events.at(-1)).toEqual({
      kind: 'disconnected',
      roomId: ROOM_ID,
      code: 'PARTICIPANT_REMOVED',
    })
    await clock.advanceAsync(60_000)
    expect(room.connectCalls).toHaveLength(1)
    // "Try again" also works from disconnected.
    await expect(connection.retry()).resolves.toBe('connected')
  })

  it('disconnect leaves cleanly and cancels a reconnect loop in progress', async () => {
    const { clock, diagnostics, room, connection } = setup()
    await connection.settled()
    room.connectOutcomes.push(new Error('signal'))
    room.drop()
    await flushPromises()
    expect(connection.state()).toBe('reconnecting')
    await connection.disconnect()
    expect(connection.state()).toBe('disconnected')
    expect(room.disconnectCalls).toBe(1)
    expect(clock.pending()).toBe(0)
    await clock.advanceAsync(60_000)
    expect(room.connectCalls).toHaveLength(1)
    expect(diagnostics.kinds().filter((k) => k === 'disconnected')).toEqual(['disconnected'])
    expect(diagnostics.events.at(-1)).toEqual({
      kind: 'disconnected',
      roomId: ROOM_ID,
      code: 'CLIENT_INITIATED',
    })
  })

  it('ignores the SDK disconnect event that follows an intentional leave', async () => {
    const { diagnostics, room, states, connection } = setup()
    await connection.settled()
    await connection.disconnect()
    expect(room.connected).toBe(false)
    expect(states.filter(([s]) => s === 'disconnected')).toHaveLength(1)
    expect(diagnostics.kinds()).toEqual(['connect_attempt', 'connected', 'disconnected'])
  })
})

describe('connectLiveKit — media', () => {
  it('toggles microphone and camera and maps failures to diagnostics', async () => {
    const { diagnostics, room, connection } = setup()
    await connection.settled()
    await expect(connection.setMicrophoneEnabled(true)).resolves.toEqual({ ok: true })
    expect(room.microphoneCalls).toEqual([true])

    room.cameraError = permissionError()
    const denied = await connection.setCameraEnabled(true)
    expect(denied).toMatchObject({ ok: false, kind: 'media_permission_denied' })
    expect(diagnostics.events.at(-1)).toEqual({
      kind: 'media_permission_denied',
      roomId: ROOM_ID,
      permission: 'camera',
      reason: 'Permission denied',
    })

    room.microphoneError = new Error('publish failed')
    const failed = await connection.setMicrophoneEnabled(false)
    expect(failed).toMatchObject({ ok: false, kind: 'track_publish_failed' })
    expect(diagnostics.events.at(-1)).toEqual({
      kind: 'track_publish_failed',
      roomId: ROOM_ID,
      source: 'microphone',
      reason: 'publish failed',
    })
  })

  it('maps MediaDevicesError events', async () => {
    const { diagnostics, room, connection } = setup()
    await connection.settled()
    room.emit('mediaDevicesError', permissionError(), 'videoinput')
    room.emit('mediaDevicesError', new Error('busy'), 'audioinput')
    room.emit('mediaDevicesError', new Error('unknown device'))
    expect(diagnostics.events.slice(2)).toEqual([
      {
        kind: 'media_permission_denied',
        roomId: ROOM_ID,
        reason: 'Permission denied',
        permission: 'camera',
      },
      { kind: 'media_device_error', roomId: ROOM_ID, reason: 'busy', source: 'microphone' },
      { kind: 'media_device_error', roomId: ROOM_ID, reason: 'unknown device' },
    ])
  })

  it('maps TrackSubscriptionFailed events', async () => {
    const { diagnostics, room, connection } = setup()
    await connection.settled()
    room.emit(
      'trackSubscriptionFailed',
      'TR_abc',
      fakeParticipant('h:def'),
      LIVEKIT_SUBSCRIPTION_ERRORS.SE_TRACK_NOTFOUND,
    )
    room.emit('trackSubscriptionFailed', 'TR_xyz', fakeParticipant('g:ghi'))
    expect(diagnostics.events.slice(2)).toEqual([
      {
        kind: 'track_subscribe_failed',
        roomId: ROOM_ID,
        reason: 'TR_abc from h:def',
        code: 'SE_TRACK_NOTFOUND',
      },
      { kind: 'track_subscribe_failed', roomId: ROOM_ID, reason: 'TR_xyz from g:ghi' },
    ])
  })

  it('exposes flipCamera only when a platform strategy is injected', async () => {
    const flipCamera = vi.fn(async (_room: RoomLike) => true)
    const { room, connection } = setup([], { flipCamera })
    await connection.settled()
    expect(connection.flipCamera).toBeDefined()
    await expect(connection.flipCamera?.()).resolves.toBe(true)
    expect(flipCamera).toHaveBeenCalledWith(room)
  })
})
