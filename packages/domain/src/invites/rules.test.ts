import { describe, expect, it } from 'vitest'

import { groupInviteUrl, roomInviteUrl } from '../constants'
import {
  INVITE_UNUSABLE_REASONS,
  inviteErrorCodeFor,
  invitePathPrefix,
  inviteUrl,
  isGroupInviteUsable,
  isRoomInviteUsable,
  parseInviteLink,
  remainingUses,
} from './rules'

const now = '2026-09-03T12:00:00Z'
const later = '2026-09-04T12:00:00Z'
const earlier = '2026-09-02T12:00:00Z'

describe('isGroupInviteUsable (spec §24)', () => {
  it('active, unlimited, no expiry', () => {
    expect(
      isGroupInviteUsable({ status: 'active', expiresAt: null, maxUses: null, useCount: 999, now }),
    ).toEqual({ usable: true })
    expect(
      isGroupInviteUsable({ status: 'active', expiresAt: later, maxUses: 5, useCount: 4, now }),
    ).toEqual({ usable: true })
  })

  it('expired by time or status', () => {
    expect(
      isGroupInviteUsable({
        status: 'active',
        expiresAt: earlier,
        maxUses: null,
        useCount: 0,
        now,
      }),
    ).toEqual({ usable: false, reason: 'expired' })
    expect(
      isGroupInviteUsable({ status: 'active', expiresAt: now, maxUses: null, useCount: 0, now }),
    ).toEqual({ usable: false, reason: 'expired' })
    expect(
      isGroupInviteUsable({ status: 'expired', expiresAt: later, maxUses: null, useCount: 0, now }),
    ).toEqual({ usable: false, reason: 'expired' })
    expect(
      isGroupInviteUsable({
        status: 'active',
        expiresAt: 'garbage',
        maxUses: null,
        useCount: 0,
        now,
      }),
    ).toEqual({ usable: false, reason: 'expired' })
    expect(
      isGroupInviteUsable({
        status: 'active',
        expiresAt: new Date(earlier),
        maxUses: null,
        useCount: 0,
        now: new Date(now),
      }),
    ).toEqual({ usable: false, reason: 'expired' })
  })

  it('exhausted by count or status', () => {
    expect(
      isGroupInviteUsable({ status: 'active', expiresAt: null, maxUses: 3, useCount: 3, now }),
    ).toEqual({ usable: false, reason: 'exhausted' })
    expect(
      isGroupInviteUsable({
        status: 'exhausted',
        expiresAt: null,
        maxUses: null,
        useCount: 0,
        now,
      }),
    ).toEqual({ usable: false, reason: 'exhausted' })
  })

  it('revoked beats expired beats exhausted', () => {
    expect(
      isGroupInviteUsable({ status: 'revoked', expiresAt: earlier, maxUses: 1, useCount: 5, now }),
    ).toEqual({ usable: false, reason: 'revoked' })
    expect(
      isGroupInviteUsable({ status: 'active', expiresAt: earlier, maxUses: 1, useCount: 5, now }),
    ).toEqual({ usable: false, reason: 'expired' })
  })

  it('remainingUses', () => {
    expect(remainingUses(null, 10)).toBeNull()
    expect(remainingUses(5, 2)).toBe(3)
    expect(remainingUses(5, 9)).toBe(0)
  })
})

describe('isRoomInviteUsable (spec §35)', () => {
  it('usable while the room is active and the link is fresh', () => {
    expect(
      isRoomInviteUsable({ expiresAt: later, revokedAt: null, roomStatus: 'active', now }),
    ).toEqual({ usable: true })
    expect(
      isRoomInviteUsable({ expiresAt: later, revokedAt: null, roomStatus: 'starting', now }),
    ).toEqual({ usable: true })
  })

  it('revoked, ended, expired — in that precedence', () => {
    expect(
      isRoomInviteUsable({ expiresAt: earlier, revokedAt: earlier, roomStatus: 'ended', now }),
    ).toEqual({ usable: false, reason: 'revoked' })
    expect(
      isRoomInviteUsable({ expiresAt: earlier, revokedAt: null, roomStatus: 'ended', now }),
    ).toEqual({ usable: false, reason: 'ended' })
    expect(
      isRoomInviteUsable({ expiresAt: earlier, revokedAt: null, roomStatus: 'active', now }),
    ).toEqual({ usable: false, reason: 'expired' })
  })
})

describe('error codes and URLs (spec §112)', () => {
  it('maps every reason to an error code', () => {
    expect(inviteErrorCodeFor('expired')).toBe('invite_expired')
    expect(inviteErrorCodeFor('exhausted')).toBe('invite_exhausted')
    expect(inviteErrorCodeFor('revoked')).toBe('invite_invalid')
    expect(inviteErrorCodeFor('ended')).toBe('room_ended')
    for (const reason of INVITE_UNUSABLE_REASONS)
      expect(typeof inviteErrorCodeFor(reason)).toBe('string')
  })

  it('reuses the deep link constants', () => {
    expect(inviteUrl('group', 'https://earth.social', 'tok')).toBe(
      groupInviteUrl('https://earth.social', 'tok'),
    )
    expect(inviteUrl('room', 'https://earth.social/', 'tok')).toBe(
      roomInviteUrl('https://earth.social/', 'tok'),
    )
    expect(inviteUrl('group', 'https://earth.social', 'tok')).toBe('https://earth.social/g/tok')
    expect(inviteUrl('room', 'https://earth.social', 'tok')).toBe('https://earth.social/live/tok')
    expect(invitePathPrefix('group')).toBe('/g/')
    expect(invitePathPrefix('room')).toBe('/live/')
  })

  it('parses invite links only', () => {
    expect(parseInviteLink('https://earth.social/g/abc')).toEqual({ kind: 'group', token: 'abc' })
    expect(parseInviteLink('/live/xyz?x=1')).toEqual({ kind: 'room', token: 'xyz' })
    expect(parseInviteLink('earth://live/xyz')).toEqual({ kind: 'room', token: 'xyz' })
    expect(parseInviteLink('https://earth.social/@maya')).toBeNull()
    expect(parseInviteLink('https://earth.social/p/123')).toBeNull()
    expect(parseInviteLink('nonsense')).toBeNull()
  })
})
