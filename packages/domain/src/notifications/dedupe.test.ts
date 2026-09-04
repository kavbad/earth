import { describe, expect, it } from 'vitest'

import { LIVE_NOTIFICATION_COOLDOWN_MINUTES } from '../constants'
import { NOTIFICATION_PRIORITY, NOTIFICATION_TYPES } from '../enums'
import { EarthError } from '../errors'
import {
  LIVE_SENDS_PER_WINDOW,
  NOTIFICATION_PRIORITY_BY_TYPE,
  priorityFor,
  priorityRank,
  shouldNotifyLive,
} from './dedupe'

const t0 = Date.UTC(2026, 8, 3, 20, 0, 0)
const minutes = (n: number): number => t0 + n * 60_000
const xavier = '10000000-0000-4000-8000-000000000001'
const maya = '10000000-0000-4000-8000-000000000002'
const sam = '10000000-0000-4000-8000-000000000003'
const stranger = '10000000-0000-4000-8000-000000000009'

describe('shouldNotifyLive (spec §87, ARCHITECTURE §11)', () => {
  it('initial send when the room never notified the recipient', () => {
    const decision = shouldNotifyLive({
      lastSentAt: null,
      notifiedParticipantIds: [],
      joiningParticipant: {
        humanId: xavier,
        isDirectFriendOfRecipient: true,
        mediaState: 'camera',
      },
      now: t0,
    })
    expect(decision).toEqual({
      send: true,
      reason: 'initial',
      next: {
        lastSentAt: new Date(t0).toISOString(),
        notifiedParticipantIds: [xavier],
        sendsInWindow: 1,
      },
    })
  })

  it('room-level events (start, open up) send initially and then respect the cooldown', () => {
    expect(
      shouldNotifyLive({
        lastSentAt: null,
        notifiedParticipantIds: [xavier],
        joiningParticipant: null,
        now: t0,
      }),
    ).toMatchObject({ send: true, reason: 'initial' })
    expect(
      shouldNotifyLive({
        lastSentAt: t0,
        notifiedParticipantIds: [xavier],
        joiningParticipant: null,
        now: minutes(5),
      }),
    ).toEqual({ send: false, reason: 'cooldown' })
  })

  it('participant churn within the cooldown never sends', () => {
    const base = { lastSentAt: t0, notifiedParticipantIds: [xavier], now: minutes(10) }
    expect(
      shouldNotifyLive({
        ...base,
        joiningParticipant: {
          humanId: stranger,
          isDirectFriendOfRecipient: false,
          mediaState: 'camera',
        },
      }),
    ).toEqual({ send: false, reason: 'not_direct_friend' })
    expect(
      shouldNotifyLive({
        ...base,
        joiningParticipant: { humanId: maya, isDirectFriendOfRecipient: true, mediaState: 'audio' },
      }),
    ).toEqual({ send: false, reason: 'not_on_camera' })
    expect(
      shouldNotifyLive({
        ...base,
        joiningParticipant: {
          humanId: maya,
          isDirectFriendOfRecipient: true,
          mediaState: 'watching',
        },
      }),
    ).toEqual({ send: false, reason: 'viewer_join' })
    expect(
      shouldNotifyLive({
        ...base,
        joiningParticipant: {
          humanId: xavier,
          isDirectFriendOfRecipient: true,
          mediaState: 'camera',
        },
      }),
    ).toEqual({ send: false, reason: 'already_notified' })
  })

  it('viewers never trigger a send, even with no prior notification', () => {
    expect(
      shouldNotifyLive({
        lastSentAt: null,
        notifiedParticipantIds: [],
        joiningParticipant: {
          humanId: maya,
          isDirectFriendOfRecipient: true,
          mediaState: 'watching',
        },
        now: t0,
      }),
    ).toEqual({ send: false, reason: 'viewer_join' })
  })

  it('a direct friend not yet mentioned joining on camera → second send, exactly once', () => {
    const initial = shouldNotifyLive({
      lastSentAt: null,
      notifiedParticipantIds: [],
      joiningParticipant: {
        humanId: xavier,
        isDirectFriendOfRecipient: true,
        mediaState: 'camera',
      },
      now: t0,
    })
    expect(initial.send).toBe(true)
    const state1 = initial.send ? initial.next : null
    expect(state1).not.toBeNull()
    if (state1 === null) return

    const second = shouldNotifyLive({
      ...state1,
      joiningParticipant: { humanId: maya, isDirectFriendOfRecipient: true, mediaState: 'camera' },
      now: minutes(3),
    })
    expect(second).toEqual({
      send: true,
      reason: 'friend_joined_on_camera',
      next: {
        lastSentAt: new Date(minutes(3)).toISOString(),
        notifiedParticipantIds: [xavier, maya],
        sendsInWindow: 2,
      },
    })
    const state2 = second.send ? second.next : null
    if (state2 === null) return

    const third = shouldNotifyLive({
      ...state2,
      joiningParticipant: { humanId: sam, isDirectFriendOfRecipient: true, mediaState: 'camera' },
      now: minutes(6),
    })
    expect(third).toEqual({ send: false, reason: 'extra_send_used' })
    expect(LIVE_SENDS_PER_WINDOW).toBe(2)
  })

  it('defaults sendsInWindow to 1 when only lastSentAt is known', () => {
    const decision = shouldNotifyLive({
      lastSentAt: t0,
      notifiedParticipantIds: [xavier],
      joiningParticipant: { humanId: maya, isDirectFriendOfRecipient: true, mediaState: 'camera' },
      now: minutes(3),
    })
    expect(decision).toMatchObject({
      send: true,
      reason: 'friend_joined_on_camera',
      next: { sendsInWindow: 2 },
    })
  })

  it('opens a new window once the cooldown elapsed', () => {
    const at = minutes(LIVE_NOTIFICATION_COOLDOWN_MINUTES)
    const decision = shouldNotifyLive({
      lastSentAt: new Date(t0).toISOString(),
      notifiedParticipantIds: [xavier, maya],
      sendsInWindow: 2,
      joiningParticipant: {
        humanId: stranger,
        isDirectFriendOfRecipient: false,
        mediaState: 'camera',
      },
      now: at,
    })
    expect(decision).toEqual({
      send: true,
      reason: 'cooldown_elapsed',
      next: {
        lastSentAt: new Date(at).toISOString(),
        notifiedParticipantIds: [xavier, maya, stranger],
        sendsInWindow: 1,
      },
    })
    expect(
      shouldNotifyLive({
        lastSentAt: t0,
        notifiedParticipantIds: [],
        sendsInWindow: 2,
        joiningParticipant: null,
        now: minutes(LIVE_NOTIFICATION_COOLDOWN_MINUTES - 1),
      }),
    ).toEqual({ send: false, reason: 'cooldown' })
  })

  it('rejects unparsable instants with EarthError(invalid_input), never a RangeError', () => {
    const base = { notifiedParticipantIds: [], joiningParticipant: null }
    for (const bad of [
      { ...base, lastSentAt: null, now: 'garbage' },
      { ...base, lastSentAt: null, now: Number.NaN },
      { ...base, lastSentAt: 'yesterday', now: t0 },
      { ...base, lastSentAt: new Date('nope'), now: t0 },
    ]) {
      let caught: unknown
      try {
        shouldNotifyLive(bad)
      } catch (error) {
        caught = error
      }
      expect(caught, JSON.stringify(bad)).toBeInstanceOf(EarthError)
      expect((caught as EarthError).code).toBe('invalid_input')
      expect((caught as EarthError).details?.['reason']).toBe('invalid_date')
    }
  })

  it('honors a custom cooldown', () => {
    expect(
      shouldNotifyLive({
        lastSentAt: t0,
        notifiedParticipantIds: [],
        joiningParticipant: null,
        now: minutes(6),
        cooldownMinutes: 5,
      }),
    ).toMatchObject({ send: true, reason: 'cooldown_elapsed' })
    expect(
      shouldNotifyLive({
        lastSentAt: t0,
        notifiedParticipantIds: [],
        joiningParticipant: null,
        now: minutes(4),
        cooldownMinutes: 5,
      }),
    ).toEqual({ send: false, reason: 'cooldown' })
  })
})

describe('priorityFor (spec §40, SCREEN 23)', () => {
  it('maps every notification type', () => {
    expect(NOTIFICATION_PRIORITY_BY_TYPE).toEqual({
      friend_live: 'critical_social',
      multi_live: 'critical_social',
      group_live: 'critical_social',
      direct_message: 'high',
      friend_request: 'high',
      friend_accepted: 'high',
      group_invitation: 'high',
      group_message: 'normal',
      follow: 'low',
    })
    for (const type of NOTIFICATION_TYPES)
      expect(NOTIFICATION_PRIORITY).toContain(priorityFor(type))
  })

  it('ranks critical_social first and low last', () => {
    expect([...NOTIFICATION_PRIORITY].sort((a, b) => priorityRank(a) - priorityRank(b))).toEqual([
      'critical_social',
      'high',
      'normal',
      'low',
    ])
    expect(priorityRank(priorityFor('friend_live'))).toBeLessThan(
      priorityRank(priorityFor('follow')),
    )
  })
})
