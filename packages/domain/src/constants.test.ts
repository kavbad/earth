import { describe, expect, it } from 'vitest'

import {
  DEEP_LINK_PATHS,
  GUEST_SESSION_GRACE_SECONDS,
  HANDLE_REGEX,
  INVITE_TOKEN_BYTES,
  LIVE_NOTIFICATION_COOLDOWN_MINUTES,
  LOCATION_SHARE_MAX_MINUTES,
  MEDIA_GRANT_TTL_SECONDS,
  groupInviteUrl,
  parseDeepLink,
  postUrl,
  profileUrl,
  ROOM_GRACE_SECONDS_DEFAULT,
  roomInviteUrl,
} from './constants'

const ORIGIN = 'https://earth.social'

describe('constants', () => {
  it('match ARCHITECTURE §10/§11 and the spec', () => {
    expect(ROOM_GRACE_SECONDS_DEFAULT).toBe(120)
    expect(GUEST_SESSION_GRACE_SECONDS).toBe(600)
    expect(LIVE_NOTIFICATION_COOLDOWN_MINUTES).toBe(30)
    expect(INVITE_TOKEN_BYTES).toBe(32)
    expect(MEDIA_GRANT_TTL_SECONDS).toBe(7200)
    expect(LOCATION_SHARE_MAX_MINUTES).toBeLessThanOrEqual(24 * 60)
  })

  it('HANDLE_REGEX: 3–24 chars, lowercase letters/digits/underscore, starts with a letter', () => {
    expect(HANDLE_REGEX.test('maya')).toBe(true)
    expect(HANDLE_REGEX.test('x_1')).toBe(true)
    expect(HANDLE_REGEX.test('a'.repeat(24))).toBe(true)
    expect(HANDLE_REGEX.test('a'.repeat(25))).toBe(false)
    expect(HANDLE_REGEX.test('ab')).toBe(false)
    expect(HANDLE_REGEX.test('1abc')).toBe(false)
    expect(HANDLE_REGEX.test('_abc')).toBe(false)
    expect(HANDLE_REGEX.test('Maya')).toBe(false)
    expect(HANDLE_REGEX.test('ma-ya')).toBe(false)
  })
})

describe('deep links (spec §112)', () => {
  it('builds the four required links', () => {
    expect(groupInviteUrl(ORIGIN, 'tok_abc')).toBe('https://earth.social/g/tok_abc')
    expect(roomInviteUrl(ORIGIN, 'tok_xyz')).toBe('https://earth.social/live/tok_xyz')
    expect(profileUrl(ORIGIN, 'maya')).toBe('https://earth.social/@maya')
    expect(postUrl(ORIGIN, '11111111-1111-4111-8111-111111111111')).toBe(
      'https://earth.social/p/11111111-1111-4111-8111-111111111111',
    )
    expect(DEEP_LINK_PATHS.groupInvite).toBe('/g/')
  })

  it('tolerates a trailing slash on the origin and encodes the token', () => {
    expect(groupInviteUrl('https://earth.social/', 'a b')).toBe('https://earth.social/g/a%20b')
    expect(profileUrl('http://localhost:3000', 'maya')).toBe('http://localhost:3000/@maya')
  })

  it('parses paths and full urls back', () => {
    expect(parseDeepLink('/g/tok_abc')).toEqual({ kind: 'group_invite', token: 'tok_abc' })
    expect(parseDeepLink('/live/tok_xyz/')).toEqual({ kind: 'room_invite', token: 'tok_xyz' })
    expect(parseDeepLink('/@maya')).toEqual({ kind: 'profile', handle: 'maya' })
    expect(parseDeepLink('https://earth.social/p/abc?utm=1#x')).toEqual({
      kind: 'post',
      postId: 'abc',
    })
    expect(parseDeepLink('earth://live/tok')).toEqual({ kind: 'room_invite', token: 'tok' })
    expect(parseDeepLink('/')).toBeNull()
    expect(parseDeepLink('/g/')).toBeNull()
    expect(parseDeepLink('/g/a/b')).toBeNull()
    expect(parseDeepLink('/settings')).toBeNull()
    expect(parseDeepLink('/gabc')).toBeNull()
    expect(parseDeepLink('/p/%E0%A4%A')).toBeNull()
    expect(parseDeepLink('earth://@maya')).toEqual({ kind: 'profile', handle: 'maya' })
  })
})
