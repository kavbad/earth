import {
  AUTHORIZATION_HEADER,
  CRON_SECRET_HEADER,
  type EarthRequest,
  fromWebRequest,
} from '@earth/server'
import { describe, expect, it } from 'vitest'

import {
  CRON_ROUTE_METHOD,
  type CronCredentials,
  adaptCronRequest,
  cronSecretForBearer,
  isInternalRoute,
} from './cron'
import { TEST_CRON_SECRET, TEST_VERCEL_CRON_SECRET, webRequest } from './fakes'

const credentials: CronCredentials = {
  internalSecret: TEST_CRON_SECRET,
  vercelCronSecret: TEST_VERCEL_CRON_SECRET,
}
const SWEEP = '/api/internal/rooms/sweep'

function earthRequest(path: string, init: Parameters<typeof webRequest>[1] = {}): EarthRequest {
  return fromWebRequest(webRequest(path, init))
}

describe('isInternalRoute', () => {
  it('matches only /api/internal/* paths', () => {
    expect(isInternalRoute(SWEEP)).toBe(true)
    expect(isInternalRoute('/api/internal/push/dispatch')).toBe(true)
    expect(isInternalRoute('/api/internal')).toBe(false)
    expect(isInternalRoute('/api/feed')).toBe(false)
    expect(isInternalRoute('/api/rooms/internal/token')).toBe(false)
  })
})

describe('cronSecretForBearer', () => {
  it('maps the Vercel CRON_SECRET bearer to INTERNAL_CRON_SECRET', () => {
    expect(cronSecretForBearer(TEST_VERCEL_CRON_SECRET, credentials)).toBe(TEST_CRON_SECRET)
  })

  it('forwards any other bearer verbatim for the server to compare', () => {
    expect(cronSecretForBearer('something-else', credentials)).toBe('something-else')
    expect(cronSecretForBearer(TEST_CRON_SECRET, credentials)).toBe(TEST_CRON_SECRET)
  })

  it('never maps when CRON_SECRET is unset, and yields null without a bearer', () => {
    const without: CronCredentials = { internalSecret: TEST_CRON_SECRET, vercelCronSecret: undefined }
    expect(cronSecretForBearer(TEST_VERCEL_CRON_SECRET, without)).toBe(TEST_VERCEL_CRON_SECRET)
    expect(cronSecretForBearer(null, credentials)).toBeNull()
  })
})

describe('adaptCronRequest', () => {
  it('returns the same request for routes outside /api/internal/', () => {
    const req = earthRequest('/api/feed?scope=world', { bearer: TEST_VERCEL_CRON_SECRET })
    expect(adaptCronRequest(req, credentials)).toBe(req)
  })

  it('returns the same request when no credential is present', () => {
    const post = earthRequest(SWEEP, { method: 'POST' })
    expect(adaptCronRequest(post, credentials)).toBe(post)
    const get = earthRequest(SWEEP)
    expect(adaptCronRequest(get, credentials)).toBe(get)
  })

  it('turns a Vercel cron GET with the CRON_SECRET bearer into a POST with x-earth-cron-secret', () => {
    const req = earthRequest(SWEEP, { bearer: TEST_VERCEL_CRON_SECRET })
    const adapted = adaptCronRequest(req, credentials)
    expect(adapted.method).toBe(CRON_ROUTE_METHOD)
    expect(adapted.headers.get(CRON_SECRET_HEADER)).toBe(TEST_CRON_SECRET)
    expect(adapted.headers.get(AUTHORIZATION_HEADER)).toBeNull()
    expect(adapted.url).toBe(req.url)
    // The original request is untouched.
    expect(req.method).toBe('GET')
    expect(req.headers.get(CRON_SECRET_HEADER)).toBeNull()
  })

  it('forwards another bearer verbatim so the server can reject it in constant time', () => {
    const adapted = adaptCronRequest(earthRequest(SWEEP, { bearer: 'wrong' }), credentials)
    expect(adapted.method).toBe(CRON_ROUTE_METHOD)
    expect(adapted.headers.get(CRON_SECRET_HEADER)).toBe('wrong')
  })

  it('keeps an existing x-earth-cron-secret header and only fixes the method', () => {
    const req = earthRequest(SWEEP, {
      headers: { [CRON_SECRET_HEADER]: TEST_CRON_SECRET, [AUTHORIZATION_HEADER]: 'Bearer keep' },
    })
    const adapted = adaptCronRequest(req, credentials)
    expect(adapted.method).toBe(CRON_ROUTE_METHOD)
    expect(adapted.headers.get(CRON_SECRET_HEADER)).toBe(TEST_CRON_SECRET)
    expect(adapted.headers.get(AUTHORIZATION_HEADER)).toBe('Bearer keep')
  })

  it('leaves a POST method alone and preserves the body', async () => {
    const req = earthRequest(SWEEP, { method: 'POST', body: { day: '2026-09-02' }, bearer: TEST_VERCEL_CRON_SECRET })
    const adapted = adaptCronRequest(req, credentials)
    expect(adapted.method).toBe('POST')
    await expect(adapted.text()).resolves.toBe('{"day":"2026-09-02"}')
    await expect(adapted.json()).resolves.toEqual({ day: '2026-09-02' })
  })
})
