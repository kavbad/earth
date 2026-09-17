import type { RoomParticipantDto } from '@earth/domain'
import type { RoomParticipantDelta } from '@earth/realtime'
import { describe, expect, it } from 'vitest'

import { EMPTY_TILES, applyDeltas, applySnapshot, tileList, tilesReducer } from './tiles'

const HUMAN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as RoomParticipantDto['humanId'] & string
const HUMAN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as RoomParticipantDto['humanId'] & string
const HUMAN_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as RoomParticipantDto['humanId'] & string
const GUEST = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as RoomParticipantDto['guestSessionId'] &
  string

function participant(
  id: string,
  humanId: RoomParticipantDto['humanId'],
  overrides: Partial<RoomParticipantDto> = {},
): RoomParticipantDto {
  return {
    id,
    humanId,
    guestSessionId: null,
    displayName: id.toUpperCase(),
    avatarUrl: null,
    isGuest: false,
    role: 'participant',
    mediaState: 'camera',
    status: 'active',
    audienceConsentLevel: 'group',
    joinedAt: '2026-09-03T10:00:00.000Z',
    relationToViewer: 'friend',
    ...overrides,
  }
}

const a = participant('a', HUMAN_A, { joinedAt: '2026-09-03T10:00:00.000Z' })
const b = participant('b', HUMAN_B, { joinedAt: '2026-09-03T10:01:00.000Z', mediaState: 'audio' })
const c = participant('c', HUMAN_C, { joinedAt: '2026-09-03T09:59:00.000Z' })
const viewer = participant('v', HUMAN_C, { mediaState: 'watching' })
const guest = participant('g', null, {
  guestSessionId: GUEST,
  isGuest: true,
  joinedAt: '2026-09-03T10:02:00.000Z',
})

describe('applySnapshot (participants → tiles)', () => {
  it('builds tiles for active publishers in join order and skips viewers', () => {
    const state = applySnapshot(EMPTY_TILES, { participants: [a, b, viewer, c] }, 'a')
    expect(state.order).toEqual(['c', 'a', 'b'])
    expect(tileList(state).map((t) => t.identity)).toEqual([
      `h:${HUMAN_C}`,
      `h:${HUMAN_A}`,
      `h:${HUMAN_B}`,
    ])
    expect(state.byId['a']?.isSelf).toBe(true)
    expect(state.byId['b']?.isSelf).toBe(false)
    expect(state.byId['b']?.mediaState).toBe('audio')
  })

  it('keeps surviving tiles in place, drops leavers, appends newcomers', () => {
    const first = applySnapshot(EMPTY_TILES, { participants: [a, b] }, null)
    const next = applySnapshot(
      first,
      { participants: [b, { ...a, status: 'left' }, guest, c] },
      null,
    )
    expect(next.order).toEqual(['b', 'c', 'g'])
    expect(next.byId['g']).toMatchObject({ isGuest: true, identity: `g:${GUEST}` })
  })

  it('returns the same state when nothing changed', () => {
    const first = applySnapshot(EMPTY_TILES, { participants: [a, b] }, null)
    expect(applySnapshot(first, { participants: [a, b] }, null)).toBe(first)
    expect(applySnapshot(first, { participants: [b, a] }, null)).toBe(first)
  })

  it('updates a tile whose media state or role changed without moving it', () => {
    const first = applySnapshot(EMPTY_TILES, { participants: [a, b] }, null)
    const next = applySnapshot(
      first,
      { participants: [{ ...a, mediaState: 'audio', role: 'moderator' }, b] },
      null,
    )
    expect(next.order).toEqual(['a', 'b'])
    expect(next.byId['a']).toMatchObject({ mediaState: 'audio', role: 'moderator' })
    expect(next.byId['b']).toBe(first.byId['b'])
  })
})

describe('applyDeltas (subscribeRoom participant deltas → tiles)', () => {
  const start = applySnapshot(EMPTY_TILES, { participants: [a, b] }, 'a')

  it('appends a joiner and removes a leaver', () => {
    const deltas: RoomParticipantDelta[] = [
      { kind: 'participant_joined', participant: c },
      { kind: 'participant_left', participant: { ...b, status: 'left' } },
    ]
    const next = applyDeltas(start, deltas, 'a')
    expect(next.order).toEqual(['a', 'c'])
  })

  it('ignores a joiner who only watches', () => {
    const next = applyDeltas(start, [{ kind: 'participant_joined', participant: viewer }], 'a')
    expect(next).toBe(start)
  })

  it('removes a tile that dropped to watching and re-adds one that came back on audio', () => {
    const gone = applyDeltas(
      start,
      [
        {
          kind: 'media_state_changed',
          participant: { ...a, mediaState: 'watching' },
          previous: 'camera',
        },
      ],
      'a',
    )
    expect(gone.order).toEqual(['b'])
    const back = applyDeltas(
      gone,
      [
        {
          kind: 'media_state_changed',
          participant: { ...a, mediaState: 'audio' },
          previous: 'watching',
        },
      ],
      'a',
    )
    expect(back.order).toEqual(['b', 'a'])
    expect(back.byId['a']).toMatchObject({ mediaState: 'audio', isSelf: true })
  })

  it('updates role and consent in place', () => {
    const next = applyDeltas(
      start,
      [
        { kind: 'role_changed', participant: { ...b, role: 'moderator' }, previous: 'participant' },
        {
          kind: 'consent_changed',
          participant: { ...b, role: 'moderator', audienceConsentLevel: 'world' },
          previous: 'group',
        },
      ],
      'a',
    )
    expect(next.order).toEqual(['a', 'b'])
    expect(next.byId['b']).toMatchObject({ role: 'moderator', consentLevel: 'world' })
  })
})

describe('tilesReducer', () => {
  it('dispatches snapshot, deltas and reset', () => {
    const snap = tilesReducer(EMPTY_TILES, {
      type: 'snapshot',
      room: { participants: [a] },
      selfParticipantId: null,
    })
    expect(snap.order).toEqual(['a'])
    const withB = tilesReducer(snap, {
      type: 'deltas',
      deltas: [{ kind: 'participant_joined', participant: b }],
      selfParticipantId: null,
    })
    expect(withB.order).toEqual(['a', 'b'])
    expect(tilesReducer(withB, { type: 'reset' })).toBe(EMPTY_TILES)
    expect(tilesReducer(EMPTY_TILES, { type: 'reset' })).toBe(EMPTY_TILES)
  })
})
