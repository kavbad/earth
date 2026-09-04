import {
  GuestSessionIdSchema,
  type RoomDto,
  type RoomParticipantDto,
  asHumanId,
  asRoomId,
} from '@earth/domain'
import { describe, expect, it, vi } from 'vitest'

import { REALTIME_TABLES } from './channel'
import {
  ROOM_POLL_INTERVAL_MS,
  type RoomParticipantDelta,
  type RoomStateDelta,
  type SubscribeRoomOptions,
  diffRoomState,
  participantDeltas,
  subscribeRoom,
} from './room'
import { createFakeClock, flushPromises } from './testing/fake-clock'
import { createFakeSupabase } from './testing/fake-supabase'
import { createRecordingDiagnostics } from './testing/fakes'

const ROOM_ID = asRoomId('55555555-5555-4555-8555-555555555555')
const XAVIER = asHumanId('66666666-6666-4666-8666-666666666661')
const KAVON = asHumanId('66666666-6666-4666-8666-666666666662')
const P_XAVIER = '77777777-7777-4777-8777-777777777771'
const P_KAVON = '77777777-7777-4777-8777-777777777772'
const ISO = '2026-09-03T12:00:00.000Z'

function participant(
  id: string,
  humanId: RoomParticipantDto['humanId'],
  overrides: Partial<RoomParticipantDto> = {},
): RoomParticipantDto {
  return {
    id,
    humanId,
    guestSessionId: null,
    displayName: 'Xavier',
    avatarUrl: null,
    isGuest: false,
    role: 'participant',
    mediaState: 'camera',
    status: 'active',
    audienceConsentLevel: 'group',
    joinedAt: ISO,
    relationToViewer: 'friend',
    ...overrides,
  }
}

function room(overrides: Partial<RoomDto> = {}): RoomDto {
  return {
    id: ROOM_ID,
    contextType: 'group',
    contextId: '88888888-8888-4888-8888-888888888888',
    initiatedByHumanId: XAVIER,
    visibility: 'group',
    joinPolicy: 'group',
    status: 'active',
    areaPrecision: 'none',
    areaId: null,
    placeId: null,
    createdAt: ISO,
    startedAt: ISO,
    endedAt: null,
    pendingVisibility: null,
    participants: [participant(P_XAVIER, XAVIER, { role: 'initiator' })],
    myParticipant: null,
    contextTitle: 'Weekend Crew',
    guestsDisabled: false,
    ...overrides,
  }
}

describe('diffRoomState', () => {
  it('reports joins, leaves and per-participant changes', () => {
    const before = room({
      participants: [
        participant(P_XAVIER, XAVIER, { role: 'initiator' }),
        participant(P_KAVON, KAVON, { mediaState: 'watching', role: 'viewer' }),
      ],
    })
    const after = room({
      participants: [
        participant(P_XAVIER, XAVIER, { role: 'initiator', status: 'left' }),
        participant(P_KAVON, KAVON, {
          mediaState: 'camera',
          role: 'moderator',
          audienceConsentLevel: 'friends',
        }),
        participant('77777777-7777-4777-8777-777777777773', null, {
          guestSessionId: GuestSessionIdSchema.parse('99999999-9999-4999-8999-999999999999'),
          isGuest: true,
          displayName: 'Guest',
          relationToViewer: null,
        }),
      ],
    })
    const deltas = diffRoomState(before, after)
    expect(deltas.map((d) => d.kind)).toEqual([
      'participant_left',
      'media_state_changed',
      'role_changed',
      'consent_changed',
      'participant_joined',
    ])
    const left = deltas[0] as Extract<RoomStateDelta, { kind: 'participant_left' }>
    expect(left.participant.status).toBe('left')
    const media = deltas[1] as Extract<RoomStateDelta, { kind: 'media_state_changed' }>
    expect(media.previous).toBe('watching')
    const role = deltas[2] as Extract<RoomStateDelta, { kind: 'role_changed' }>
    expect(role.previous).toBe('viewer')
    const consent = deltas[3] as Extract<RoomStateDelta, { kind: 'consent_changed' }>
    expect(consent.previous).toBe('group')
    expect(participantDeltas(deltas)).toHaveLength(5)
  })

  it('ignores participants that are not active in either state', () => {
    const before = room({ participants: [participant(P_KAVON, KAVON, { status: 'invited' })] })
    const after = room({ participants: [participant(P_KAVON, KAVON, { status: 'waiting' })] })
    expect(diffRoomState(before, after)).toEqual([])
  })

  it('reports room-level changes and the end of the room', () => {
    const before = room()
    const after = room({
      visibility: 'friends',
      joinPolicy: 'friends',
      pendingVisibility: 'world',
      status: 'ended',
      endedAt: ISO,
    })
    const deltas = diffRoomState(before, after)
    expect(deltas).toEqual([
      {
        kind: 'room_updated',
        changes: {
          visibility: 'friends',
          joinPolicy: 'friends',
          pendingVisibility: 'world',
          status: 'ended',
        },
        previous: {
          visibility: 'group',
          joinPolicy: 'group',
          pendingVisibility: null,
          status: 'active',
        },
      },
      { kind: 'room_ended' },
    ])
    expect(participantDeltas(deltas)).toEqual([])
    expect(diffRoomState(after, after)).toEqual([])
  })
})

function setup(states: RoomDto[], overrides: Partial<SubscribeRoomOptions> = {}) {
  const supabase = createFakeSupabase()
  const clock = createFakeClock()
  const diagnostics = createRecordingDiagnostics()
  const queue = [...states]
  const fetchState = vi.fn(async (): Promise<RoomDto> => {
    const next = queue.shift()
    if (next === undefined) throw new Error('no more states')
    return next
  })
  const rooms: Array<[RoomDto, readonly RoomStateDelta[]]> = []
  const tiles: Array<[readonly RoomParticipantDto[], readonly RoomParticipantDelta[]]> = []
  const subscription = subscribeRoom({
    supabase,
    roomId: ROOM_ID,
    fetchState,
    onRoom: (state, deltas) => rooms.push([state, deltas]),
    onParticipants: (participants, deltas) => tiles.push([participants, deltas]),
    diagnostics,
    clock,
    ...overrides,
  })
  return { supabase, clock, diagnostics, fetchState, queue, rooms, tiles, subscription }
}

describe('subscribeRoom', () => {
  it('fetches the initial state, refreshes on changes and emits deltas', async () => {
    const joined = room({
      participants: [
        participant(P_XAVIER, XAVIER, { role: 'initiator' }),
        participant(P_KAVON, KAVON),
      ],
    })
    const { supabase, fetchState, rooms, tiles, subscription } = setup([room(), room(), joined])
    const channel = supabase.latest()
    expect(channel.topic).toBe(`room:${ROOM_ID}:changes`)
    expect(channel.postgresBindings.map((b) => b.filter)).toEqual([
      { event: '*', schema: 'public', table: 'room_participants', filter: `room_id=eq.${ROOM_ID}` },
      { event: '*', schema: 'public', table: 'rooms', filter: `id=eq.${ROOM_ID}` },
    ])
    await flushPromises()
    expect(fetchState).toHaveBeenCalledTimes(1)
    expect(rooms).toHaveLength(1)
    expect(rooms[0]?.[1]).toEqual([])
    expect(subscription.current()?.id).toBe(ROOM_ID)

    channel.emitStatus('SUBSCRIBED')
    await flushPromises()
    expect(fetchState).toHaveBeenCalledTimes(2)
    expect(rooms[1]?.[1]).toEqual([])

    channel.emitChange(REALTIME_TABLES.roomParticipants, 'INSERT', {
      id: P_KAVON,
      room_id: ROOM_ID,
    })
    await flushPromises()
    expect(fetchState).toHaveBeenCalledTimes(3)
    expect(rooms[2]?.[1]).toEqual([
      { kind: 'participant_joined', participant: joined.participants[1] },
    ])
    expect(tiles[2]?.[0].map((p) => p.id)).toEqual([P_XAVIER, P_KAVON])
    expect(tiles[2]?.[1]).toHaveLength(1)
  })

  it('coalesces bursts of changes into one in-flight fetch plus one follow-up', async () => {
    const supabase = createFakeSupabase()
    const clock = createFakeClock()
    const resolvers: Array<(state: RoomDto) => void> = []
    const fetchState = vi.fn(
      () =>
        new Promise<RoomDto>((resolve) => {
          resolvers.push(resolve)
        }),
    )
    const onRoom = vi.fn()
    subscribeRoom({ supabase, roomId: ROOM_ID, fetchState, onRoom, clock })
    expect(fetchState).toHaveBeenCalledTimes(1)
    const channel = supabase.latest()
    channel.emitStatus('SUBSCRIBED')
    channel.emitChange(REALTIME_TABLES.rooms, 'UPDATE', { id: ROOM_ID })
    channel.emitChange(REALTIME_TABLES.roomParticipants, 'UPDATE', { id: P_KAVON })
    expect(fetchState).toHaveBeenCalledTimes(1)
    resolvers[0]?.(room())
    await flushPromises()
    expect(fetchState).toHaveBeenCalledTimes(2)
    resolvers[1]?.(room({ visibility: 'friends', joinPolicy: 'friends' }))
    await flushPromises()
    expect(fetchState).toHaveBeenCalledTimes(2)
    expect(onRoom).toHaveBeenCalledTimes(2)
    expect(onRoom.mock.calls[1]?.[1]).toEqual([
      {
        kind: 'room_updated',
        changes: { visibility: 'friends', joinPolicy: 'friends' },
        previous: { visibility: 'group', joinPolicy: 'group' },
      },
    ])
  })

  it('polls every 3 s after fallback and stops on recovery', async () => {
    const { supabase, clock, diagnostics, fetchState, subscription } = setup(
      Array.from({ length: 10 }, () => room()),
    )
    await flushPromises()
    expect(fetchState).toHaveBeenCalledTimes(1)
    await clock.advanceAsync(5_000)
    expect(subscription.mode()).toBe('polling')
    expect(fetchState).toHaveBeenCalledTimes(2)
    expect(diagnostics.events[0]).toMatchObject({
      kind: 'realtime_fallback',
      channel: 'room',
      roomId: ROOM_ID,
      code: 'join_timeout',
    })
    await clock.advanceAsync(ROOM_POLL_INTERVAL_MS)
    expect(fetchState).toHaveBeenCalledTimes(3)

    // The channel was re-created after 1 s of backoff; joining it ends polling.
    expect(supabase.channels).toHaveLength(2)
    supabase.latest().emitStatus('SUBSCRIBED')
    await flushPromises()
    expect(subscription.mode()).toBe('realtime')
    expect(diagnostics.kinds()).toEqual(['realtime_fallback', 'realtime_recovered'])
    // One refresh on join, then no more polls.
    expect(fetchState).toHaveBeenCalledTimes(4)
    await clock.advanceAsync(ROOM_POLL_INTERVAL_MS * 3)
    expect(fetchState).toHaveBeenCalledTimes(4)
  })

  it('reports fetch failures once per streak and keeps the last state', async () => {
    const { clock, diagnostics, fetchState, subscription, queue } = setup([room()])
    await flushPromises()
    expect(subscription.current()).not.toBeNull()
    await clock.advanceAsync(5_000)
    expect(diagnostics.kinds()).toEqual(['realtime_fallback', 'realtime_poll_failed'])
    expect(diagnostics.events[1]).toMatchObject({ channel: 'room', reason: 'no more states' })
    await clock.advanceAsync(ROOM_POLL_INTERVAL_MS)
    expect(diagnostics.kinds()).toHaveLength(2)
    queue.push(room())
    await clock.advanceAsync(ROOM_POLL_INTERVAL_MS)
    expect(fetchState).toHaveBeenCalledTimes(4)
    expect(subscription.current()?.status).toBe('active')
  })

  it('releases the channel and timers once the room has ended', async () => {
    const ended = room({ status: 'ended', endedAt: ISO, participants: [] })
    const { supabase, clock, fetchState, rooms, subscription } = setup([room(), ended])
    await flushPromises()
    supabase.latest().emitStatus('SUBSCRIBED')
    await flushPromises()
    expect(rooms[1]?.[1].map((d) => d.kind)).toEqual([
      'participant_left',
      'room_updated',
      'room_ended',
    ])
    expect(supabase.active()).toHaveLength(0)
    expect(clock.pending()).toBe(0)
    await clock.advanceAsync(30_000)
    expect(fetchState).toHaveBeenCalledTimes(2)
    subscription.unsubscribe()
  })

  it('keeps exactly one poll timer across rapid flapping', async () => {
    const { supabase, clock, fetchState, subscription } = setup(
      Array.from({ length: 10 }, () => room()),
    )
    await flushPromises()
    expect(fetchState).toHaveBeenCalledTimes(1)
    supabase.latest().emitStatus('CHANNEL_ERROR')
    await flushPromises()
    expect(fetchState).toHaveBeenCalledTimes(2)
    // Re-subscribe timer (1 s) + poll timer (3 s).
    expect(clock.pending()).toBe(2)
    await clock.advanceAsync(1_000)
    supabase.latest().emitStatus('SUBSCRIBED')
    await flushPromises()
    expect(clock.pending()).toBe(0)
    supabase.latest().emitStatus('CHANNEL_ERROR')
    await flushPromises()
    expect(clock.pending()).toBe(2)
    await clock.advanceAsync(ROOM_POLL_INTERVAL_MS)
    expect(clock.pending()).toBe(2)
    subscription.unsubscribe()
    expect(clock.pending()).toBe(0)
  })

  it('drops a state that resolves after unsubscribe', async () => {
    const supabase = createFakeSupabase()
    const clock = createFakeClock()
    let resolveState: (state: RoomDto) => void = () => undefined
    const fetchState = vi.fn(
      () =>
        new Promise<RoomDto>((resolve) => {
          resolveState = resolve
        }),
    )
    const onRoom = vi.fn()
    const subscription = subscribeRoom({ supabase, roomId: ROOM_ID, fetchState, onRoom, clock })
    subscription.unsubscribe()
    resolveState(room())
    await flushPromises()
    expect(onRoom).not.toHaveBeenCalled()
    expect(subscription.current()).toBeNull()
    expect(supabase.active()).toHaveLength(0)
  })

  it('uses a provided initial state as the diff baseline', async () => {
    const initial = room({ participants: [] })
    const { rooms } = setup([room()], { initialState: initial })
    await flushPromises()
    expect(rooms[0]?.[1].map((d) => d.kind)).toEqual(['participant_joined'])
  })
})
