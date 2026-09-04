import { describe, expect, it } from 'vitest'

import {
  ROUTES,
  TAB_ROUTES,
  authCallbackRoute,
  claimJoinRoute,
  conversationRoute,
  groupInviteRoute,
  safeNextPath,
  tabForPathname,
} from './routes'

describe('routes', () => {
  it('maps the five tabs in spec §50 order', () => {
    expect(Object.keys(TAB_ROUTES)).toEqual(['home', 'chats', 'live', 'earth', 'you'])
    expect(TAB_ROUTES.live).toBe('/live')
  })

  it('encodes ids and tokens in dynamic routes', () => {
    expect(conversationRoute('c 1')).toBe('/chats/c%201')
    expect(groupInviteRoute('tok/en')).toBe('/g/tok%2Fen')
    expect(claimJoinRoute('a&b')).toBe('/claim/join?token=a%26b')
    expect(authCallbackRoute('/claim/credential')).toBe('/auth/callback?next=%2Fclaim%2Fcredential')
  })

  it('finds the tab that owns a path', () => {
    expect(tabForPathname('/home')).toBe('home')
    expect(tabForPathname('/chats/abc')).toBe('chats')
    expect(tabForPathname('/claim')).toBeNull()
    expect(tabForPathname('/liveness')).toBeNull()
  })

  it('only follows same-origin absolute paths after auth', () => {
    expect(safeNextPath('/claim/credential', ROUTES.home)).toBe('/claim/credential')
    expect(safeNextPath('//evil.example', ROUTES.home)).toBe('/home')
    expect(safeNextPath('https://evil.example/x', ROUTES.home)).toBe('/home')
    expect(safeNextPath(null, ROUTES.home)).toBe('/home')
  })
})
