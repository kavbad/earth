import { AUTHORIZATION_HEADER } from '@earth/server'
import { describe, expect, it } from 'vitest'

import {
  COOKIE_BEARER_PATH_PREFIX,
  acceptsCookieBearer,
  accessTokenOf,
  withCookieBearer,
} from './cookie-bearer'

const ORIGIN = 'http://localhost:3000'
const MEDIA = `${ORIGIN}${COOKIE_BEARER_PATH_PREFIX}media/22222222-2222-4222-8222-222222222222/a.png`
const TOKEN = 'cookie.session.jwt'
const cookieSession = async (): Promise<string | null> => TOKEN
const noSession = async (): Promise<string | null> => null

describe('accessTokenOf', () => {
  it('is the session access token, or null when there is no session or an empty token', () => {
    expect(accessTokenOf({ data: { session: { access_token: TOKEN } } })).toBe(TOKEN)
    expect(accessTokenOf({ data: { session: null } })).toBeNull()
    expect(accessTokenOf({ data: { session: { access_token: '' } } })).toBeNull()
  })
})

describe('acceptsCookieBearer', () => {
  it('is a bare GET of the media route, and nothing else', () => {
    expect(acceptsCookieBearer(new Request(MEDIA))).toBe(true)
    expect(acceptsCookieBearer(new Request(MEDIA, { method: 'POST' }))).toBe(false)
    expect(
      acceptsCookieBearer(new Request(MEDIA, { headers: { authorization: 'Bearer x' } })),
    ).toBe(false)
    expect(acceptsCookieBearer(new Request(`${ORIGIN}/api/feed?scope=friends`))).toBe(false)
    expect(acceptsCookieBearer(new Request(`${ORIGIN}/api/account/delete`))).toBe(false)
  })
})

describe('withCookieBearer', () => {
  it('presents the cookie session as the bearer of a media element request', async () => {
    const request = await withCookieBearer(new Request(MEDIA), cookieSession)
    expect(request.headers.get(AUTHORIZATION_HEADER)).toBe(`Bearer ${TOKEN}`)
    expect(request.method).toBe('GET')
    expect(request.url).toBe(MEDIA)
  })

  it('leaves a request alone when there is no session', async () => {
    const original = new Request(MEDIA)
    const request = await withCookieBearer(original, noSession)
    expect(request).toBe(original)
    expect(request.headers.has(AUTHORIZATION_HEADER)).toBe(false)
  })

  it('never signs a request that carries its own bearer, or that is not the media route', async () => {
    const own = new Request(MEDIA, { headers: { authorization: 'Bearer mine' } })
    expect(await withCookieBearer(own, cookieSession)).toBe(own)
    const feed = new Request(`${ORIGIN}/api/feed?scope=friends`)
    expect(await withCookieBearer(feed, cookieSession)).toBe(feed)
    const post = new Request(MEDIA, { method: 'POST' })
    expect(await withCookieBearer(post, cookieSession)).toBe(post)
  })
})
