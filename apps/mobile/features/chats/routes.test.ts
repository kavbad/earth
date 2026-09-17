import { describe, expect, it } from 'vitest'

import {
  CHATS_ROUTE,
  NEW_CHAT_ROUTE,
  conversationInfoRoute,
  conversationRoute,
  earthPlaceHref,
  earthShareHref,
  profileRoute,
  roomRoute,
} from './routes'

describe('chat routes (SCREEN 08–12 and hand-offs)', () => {
  it('spells the chats destinations from the shell routes', () => {
    expect(CHATS_ROUTE).toBe('/chats')
    expect(NEW_CHAT_ROUTE).toBe('/chats/new')
    expect(conversationRoute('abc')).toBe('/chats/abc')
    expect(conversationInfoRoute('abc')).toBe('/chats/abc/info')
  })

  it('escapes ids and normalizes handles', () => {
    expect(conversationRoute('a/b')).toBe('/chats/a%2Fb')
    expect(roomRoute('r 1')).toBe('/rooms/r%201')
    expect(profileRoute('@Maya')).toBe('/u/maya')
  })

  it('hands places and location sharing to the map with params', () => {
    expect(earthPlaceHref('p1')).toEqual({ pathname: '/earth', params: { place: 'p1' } })
    expect(earthShareHref('c1')).toEqual({ pathname: '/earth', params: { share: 'c1' } })
  })
})
