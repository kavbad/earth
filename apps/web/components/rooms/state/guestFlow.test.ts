import { GUEST_DISPLAY_NAME_MAX, type GuestSessionId, type RoomId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  INITIAL_GUEST_FLOW,
  type GuestFlowState,
  guestDurationMs,
  guestFlowReducer,
  guestJoinMediaState,
  normalizeGuestName,
} from './guestFlow'

const GUEST = '44444444-4444-4444-8444-444444444444' as GuestSessionId
const ROOM = '55555555-5555-4555-8555-555555555555' as RoomId

function run(
  events: Parameters<typeof guestFlowReducer>[1][],
  from = INITIAL_GUEST_FLOW,
): GuestFlowState {
  return events.reduce(guestFlowReducer, from)
}

describe('guestFlowReducer (SCREEN 17–19)', () => {
  it('walks preview → name → joining → in room → post-room → done', () => {
    const named = run([{ type: 'start' }, { type: 'name_changed', name: '  Sam  ' }])
    expect(named.step).toBe('name')
    const joining = guestFlowReducer(named, { type: 'submit' })
    expect(joining).toMatchObject({ step: 'joining', name: 'Sam', error: null })
    const inRoom = guestFlowReducer(joining, {
      type: 'joined',
      guestSessionId: GUEST,
      roomId: ROOM,
      at: 1_000,
    })
    expect(inRoom).toMatchObject({
      step: 'in_room',
      guestSessionId: GUEST,
      roomId: ROOM,
      joinedAt: 1_000,
    })
    const post = guestFlowReducer(inRoom, { type: 'left', outcome: 'left' })
    expect(post).toMatchObject({ step: 'post_room', outcome: 'left' })
    expect(guestFlowReducer(post, { type: 'finish' }).step).toBe('done')
  })

  it('refuses to join without a usable name and clears the error on typing', () => {
    const blank = run([{ type: 'start' }, { type: 'submit' }])
    expect(blank).toMatchObject({ step: 'name', error: 'name_missing' })
    expect(guestFlowReducer(blank, { type: 'name_changed', name: 'S' }).error).toBeNull()
    const tooLong = run([
      { type: 'start' },
      { type: 'name_changed', name: 'x'.repeat(GUEST_DISPLAY_NAME_MAX + 1) },
      { type: 'submit' },
    ])
    expect(tooLong.step).toBe('name')
  })

  it('returns to the name step after a recoverable failure and to the preview after a final one', () => {
    const joining = run([
      { type: 'start' },
      { type: 'name_changed', name: 'Sam' },
      { type: 'submit' },
    ])
    expect(guestFlowReducer(joining, { type: 'join_failed', error: 'join_failed' })).toMatchObject({
      step: 'name',
      error: 'join_failed',
    })
    expect(
      guestFlowReducer(joining, { type: 'join_failed', error: 'guests_disabled' }),
    ).toMatchObject({
      step: 'preview',
      error: 'guests_disabled',
    })
    expect(guestFlowReducer(joining, { type: 'join_failed', error: 'link_unusable' }).step).toBe(
      'preview',
    )
  })

  it('records the room ending while joining or in the room, and ignores stray events', () => {
    const joining = run([
      { type: 'start' },
      { type: 'name_changed', name: 'Sam' },
      { type: 'submit' },
    ])
    expect(guestFlowReducer(joining, { type: 'left', outcome: 'room_ended' }).step).toBe(
      'post_room',
    )
    expect(guestFlowReducer(INITIAL_GUEST_FLOW, { type: 'submit' })).toBe(INITIAL_GUEST_FLOW)
    expect(guestFlowReducer(INITIAL_GUEST_FLOW, { type: 'finish' })).toBe(INITIAL_GUEST_FLOW)
    expect(
      guestFlowReducer(INITIAL_GUEST_FLOW, {
        type: 'joined',
        guestSessionId: GUEST,
        roomId: ROOM,
        at: 1,
      }),
    ).toBe(INITIAL_GUEST_FLOW)
  })

  it('joins with camera only when the preview was on', () => {
    expect(guestJoinMediaState({ wantsCamera: false })).toBe('audio')
    expect(guestJoinMediaState({ wantsCamera: true })).toBe('camera')
    expect(
      guestFlowReducer(INITIAL_GUEST_FLOW, { type: 'camera_toggled', on: true }).wantsCamera,
    ).toBe(true)
  })

  it('measures time in the room', () => {
    expect(guestDurationMs({ joinedAt: null }, 5_000)).toBe(0)
    expect(guestDurationMs({ joinedAt: 1_000 }, 5_000)).toBe(4_000)
    expect(guestDurationMs({ joinedAt: 9_000 }, 5_000)).toBe(0)
  })
})

describe('normalizeGuestName', () => {
  it('trims and collapses whitespace, rejects blank and overlong names', () => {
    expect(normalizeGuestName('  Sam   Lee ')).toBe('Sam Lee')
    expect(normalizeGuestName('   ')).toBeNull()
    expect(normalizeGuestName('x'.repeat(GUEST_DISPLAY_NAME_MAX))).toHaveLength(
      GUEST_DISPLAY_NAME_MAX,
    )
    expect(normalizeGuestName('x'.repeat(GUEST_DISPLAY_NAME_MAX + 1))).toBeNull()
  })
})
