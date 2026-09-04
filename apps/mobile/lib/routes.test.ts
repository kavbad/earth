import { describe, expect, it } from 'vitest'

import {
  ROUTES,
  TAB_ROUTES,
  claimJoinHref,
  conversationRoute,
  firstParam,
  groupInviteRoute,
  postRoute,
  profileRoute,
  roomInviteRoute,
  roomRoute,
  tabForPathname,
} from './routes'

describe('routes', () => {
  it('builds the dynamic paths with encoding', () => {
    expect(conversationRoute('abc')).toBe('/chats/abc')
    expect(roomRoute('r 1')).toBe('/rooms/r%201')
    expect(profileRoute('@Maya')).toBe('/u/maya')
    expect(postRoute('p1')).toBe('/p/p1')
    expect(groupInviteRoute('tok/en')).toBe('/g/tok%2Fen')
    expect(roomInviteRoute('t')).toBe('/live/t')
    expect(claimJoinHref('t')).toEqual({ pathname: ROUTES.claimJoin, params: { token: 't' } })
  })

  it('maps a pathname to the tab that owns it', () => {
    expect(tabForPathname('/home')).toBe('home')
    expect(tabForPathname('/chats/abc/info')).toBe('chats')
    expect(tabForPathname('/live')).toBe('live')
    expect(tabForPathname('/live/token')).toBe('live')
    expect(tabForPathname('/you/settings/account')).toBe('you')
    expect(tabForPathname('/rooms/abc')).toBeNull()
    expect(tabForPathname('/claim')).toBeNull()
    expect(Object.values(TAB_ROUTES)).toEqual(['/home', '/chats', '/live', '/earth', '/you'])
  })

  it('reads the first search param', () => {
    expect(firstParam(undefined)).toBeNull()
    expect(firstParam('')).toBeNull()
    expect(firstParam('a')).toBe('a')
    expect(firstParam(['b', 'c'])).toBe('b')
  })
})
