import { describe, expect, it } from 'vitest'

import {
  CANONICAL_WEB_ORIGIN,
  linkingPrefixes,
  readPushTarget,
  redirectSystemPath,
  rewriteSystemPath,
  routeForDeepLink,
  routeForPushData,
  routeForUrl,
} from './deeplinks'

const ROOM = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = '22222222-2222-4222-8222-222222222222'
const POST = '33333333-3333-4333-8333-333333333333'
const HUMAN = '44444444-4444-4444-8444-444444444444'

describe('rewriteSystemPath', () => {
  it('rewrites the profile link to its implementation path', () => {
    expect(rewriteSystemPath('https://earth.social/@Maya')).toBe('https://earth.social/u/maya')
    expect(rewriteSystemPath('https://earth.social/@maya?ref=x')).toBe(
      'https://earth.social/u/maya?ref=x',
    )
    expect(rewriteSystemPath('earth:///@maya')).toBe('earth:///u/maya')
    expect(rewriteSystemPath('/@maya')).toBe('/u/maya')
  })

  it('leaves every other link alone', () => {
    for (const url of [
      'https://earth.social/g/token',
      'https://earth.social/live/token',
      'https://earth.social/p/abc',
      'earth://g/token',
      '/home',
      'https://earth.social/',
    ]) {
      expect(rewriteSystemPath(url)).toBe(url)
    }
  })

  it('is what +native-intent exports', () => {
    expect(redirectSystemPath({ path: 'https://earth.social/@x', initial: true })).toBe(
      'https://earth.social/u/x',
    )
  })
})

describe('linking prefixes', () => {
  it('answers to the app scheme and the canonical web origin', () => {
    expect(linkingPrefixes()).toEqual(['earth://', CANONICAL_WEB_ORIGIN])
    expect(linkingPrefixes(null)).toEqual(['earth://', CANONICAL_WEB_ORIGIN])
  })

  it('adds a configured web origin once, without a trailing slash', () => {
    expect(linkingPrefixes('http://192.168.1.20:3000/')).toEqual([
      'earth://',
      CANONICAL_WEB_ORIGIN,
      'http://192.168.1.20:3000',
    ])
    expect(linkingPrefixes(`${CANONICAL_WEB_ORIGIN}/`)).toEqual(['earth://', CANONICAL_WEB_ORIGIN])
  })
})

describe('routeForUrl', () => {
  it('maps every link of the contract to its screen (spec §112)', () => {
    expect(routeForUrl('https://earth.social/g/tok-en')).toBe('/g/tok-en')
    expect(routeForUrl('https://earth.social/live/abc?x=1')).toBe('/live/abc')
    expect(routeForUrl('https://earth.social/@Maya')).toBe('/u/maya')
    expect(routeForUrl(`https://earth.social/p/${POST}`)).toBe(`/p/${POST}`)
    expect(routeForUrl('earth://g/tok')).toBe('/g/tok')
    expect(routeForUrl('earth:///live/tok')).toBe('/live/tok')
    expect(routeForUrl('earth://@maya')).toBe('/u/maya')
  })

  it('answers null for anything outside the contract', () => {
    expect(routeForUrl('https://earth.social/home')).toBeNull()
    expect(routeForUrl('https://earth.social/')).toBeNull()
    expect(routeForUrl('https://earth.social/g/')).toBeNull()
    expect(routeForUrl('not a url')).toBeNull()
  })

  it('encodes route parameters', () => {
    expect(routeForDeepLink({ kind: 'group_invite', token: 'a b' })).toBe('/g/a%20b')
    expect(routeForDeepLink({ kind: 'profile', handle: '@Maya' })).toBe('/u/maya')
  })
})

describe('push data', () => {
  it('reads what a push points at, whatever the shape', () => {
    expect(
      readPushTarget({
        type: 'direct_message',
        objectType: 'message',
        objectId: ROOM,
        conversationId: CONVERSATION,
      }),
    ).toEqual({
      type: 'direct_message',
      roomId: null,
      conversationId: CONVERSATION,
      postId: null,
      humanId: null,
    })
    expect(readPushTarget({ type: 'follow', objectType: 'human', objectId: HUMAN })).toEqual({
      type: 'follow',
      roomId: null,
      conversationId: null,
      postId: null,
      humanId: HUMAN,
    })
    expect(readPushTarget({ type: 'nope', roomId: 'not a uuid' })).toEqual({
      type: null,
      roomId: null,
      conversationId: null,
      postId: null,
      humanId: null,
    })
    expect(readPushTarget('text')).toEqual(readPushTarget(null))
  })

  it('opens the room, then the conversation, then the post, otherwise Notifications', () => {
    expect(routeForPushData({ roomId: ROOM, conversationId: CONVERSATION })).toBe(`/rooms/${ROOM}`)
    expect(routeForPushData({ type: 'group_live', objectType: 'room', objectId: ROOM })).toBe(
      `/rooms/${ROOM}`,
    )
    expect(routeForPushData({ conversationId: CONVERSATION })).toBe(`/chats/${CONVERSATION}`)
    expect(routeForPushData({ objectType: 'conversation', objectId: CONVERSATION })).toBe(
      `/chats/${CONVERSATION}`,
    )
    expect(routeForPushData({ objectType: 'post', objectId: POST })).toBe(`/p/${POST}`)
    expect(routeForPushData({ type: 'friend_request', objectType: 'human', objectId: HUMAN })).toBe(
      '/notifications',
    )
    expect(routeForPushData({ roomId: 'not a uuid' })).toBe('/notifications')
    expect(routeForPushData(null)).toBe('/notifications')
  })
})
