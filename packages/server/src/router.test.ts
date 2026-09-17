import { EarthError } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { createFetchHandler, fromWebRequest, toWebResponse } from './adapters/fetch'
import { CRON_SECRET_HEADER } from './cron'
import { ok } from './http'
import { ROUTES, SERVICE_NAME, createEarthServer, matchPattern, matchRoute } from './router'
import { TEST_CRON_SECRET, TEST_NOW, createFakeDeps, fakeRequest } from './test/fakes'

const ROOM_ID = '22222222-2222-4222-8222-222222222222'

describe('matching', () => {
  it('captures params segment by segment', () => {
    expect(matchPattern('/api/rooms/:id/token', `/api/rooms/${ROOM_ID}/token`)).toEqual({
      id: ROOM_ID,
    })
    expect(matchPattern('/api/rooms/:id/token', `/api/rooms/${ROOM_ID}/token/`)).toEqual({
      id: ROOM_ID,
    })
    expect(matchPattern('/api/rooms/:id/token', '/api/rooms//token')).toBeNull()
    expect(matchPattern('/api/rooms/:id/token', `/api/rooms/${ROOM_ID}`)).toBeNull()
    expect(
      matchPattern('/api/claim/verification/:sessionId', '/api/claim/verification/a%20b'),
    ).toEqual({ sessionId: 'a b' })
    expect(
      matchPattern('/api/claim/verification/:sessionId', '/api/claim/verification/%E0%A4%A'),
    ).toBeNull()
  })

  it('captures the rest of the path for a trailing `:name*`', () => {
    expect(matchPattern('/api/media/:bucket/:key*', '/api/media/media/human/a.jpg')).toEqual({
      bucket: 'media',
      key: 'human/a.jpg',
    })
    expect(matchPattern('/api/media/:bucket/:key*', '/api/media/voice/h/2026/09/clip.m4a')).toEqual(
      { bucket: 'voice', key: 'h/2026/09/clip.m4a' },
    )
    expect(matchPattern('/api/media/:bucket/:key*', '/api/media/media/a%20b.jpg')).toEqual({
      bucket: 'media',
      key: 'a b.jpg',
    })
    // The rest must exist, decode, and never swallow the bucket segment.
    expect(matchPattern('/api/media/:bucket/:key*', '/api/media/media')).toBeNull()
    expect(matchPattern('/api/media/:bucket/:key*', '/api/media')).toBeNull()
    expect(matchPattern('/api/media/:bucket/:key*', '/api/media/media/%E0%A4%A')).toBeNull()
  })

  it('covers every ARCHITECTURE §6 route with the right method', () => {
    const expected: [string, string][] = [
      ['POST', `/api/rooms/${ROOM_ID}/token`],
      ['POST', '/api/livekit/webhook'],
      ['POST', '/api/claim/verification/start'],
      ['GET', '/api/claim/verification/sess-1'],
      ['POST', '/api/claim/verification/webhook'],
      ['GET', '/api/feed'],
      ['GET', '/api/live'],
      ['POST', '/api/internal/push/dispatch'],
      ['POST', '/api/internal/rooms/sweep'],
      ['POST', '/api/internal/metrics/daily'],
      ['POST', '/api/analytics/ingest'],
      ['POST', '/api/diagnostics/rtc'],
      ['GET', '/api/media/media/11111111-1111-4111-8111-111111111111/photo.jpg'],
      ['GET', '/api/health'],
    ]
    for (const [method, path] of expected) {
      expect(matchRoute(ROUTES, method, path).kind, `${method} ${path}`).toBe('matched')
    }
    // Static segments win over params regardless of table order.
    const webhook = matchRoute(ROUTES, 'POST', '/api/claim/verification/webhook')
    expect(webhook.kind === 'matched' && webhook.route.name).toBe('claim.verification.webhook')
    const result = matchRoute(ROUTES, 'GET', '/api/claim/verification/webhook')
    expect(result.kind === 'matched' && result.route.name).toBe('claim.verification.result')
  })

  it('distinguishes wrong method from unknown path', () => {
    expect(matchRoute(ROUTES, 'GET', '/api/rooms/x/token')).toEqual({
      kind: 'method_not_allowed',
      allowed: ['POST'],
    })
    expect(matchRoute(ROUTES, 'post', '/api/feed')).toEqual({
      kind: 'method_not_allowed',
      allowed: ['GET'],
    })
    expect(matchRoute(ROUTES, 'GET', '/api/nope')).toEqual({ kind: 'not_found' })
  })
})

describe('createEarthServer', () => {
  it('serves health', async () => {
    const { deps } = createFakeDeps()
    const res = await createEarthServer(deps).handle(fakeRequest({ url: '/api/health' }))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, service: SERVICE_NAME, now: TEST_NOW.toISOString() })
  })

  it('answers 404 / 405 in the JSON error shape', async () => {
    const { deps } = createFakeDeps()
    const server = createEarthServer(deps)
    const missing = await server.handle(fakeRequest({ url: '/api/nope' }))
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ error: { code: 'not_visible' } })
    const wrong = await server.handle(fakeRequest({ method: 'DELETE', url: '/api/feed' }))
    expect(wrong.status).toBe(405)
    expect(wrong.headers['allow']).toBe('GET')
    expect(wrong.body).toMatchObject({
      error: { code: 'invalid_input', details: { allowed: ['GET'] } },
    })
  })

  it('routes to handlers with params and maps thrown errors', async () => {
    const { deps, supabase, logs } = createFakeDeps({ rpc: { rooms_sweep: () => ({ ended: 0 }) } })
    const server = createEarthServer(deps)
    const unauthorized = await server.handle(
      fakeRequest({ method: 'POST', url: `/api/rooms/${ROOM_ID}/token` }),
    )
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.body).toEqual({
      error: {
        code: 'not_authenticated',
        message: 'not_authenticated',
        details: { reason: 'missing_bearer' },
      },
    })

    const swept = await server.handle(
      fakeRequest({
        method: 'POST',
        url: '/api/internal/rooms/sweep',
        headers: { [CRON_SECRET_HEADER]: TEST_CRON_SECRET },
      }),
    )
    expect(swept.status).toBe(200)
    expect(supabase.calls[0]?.name).toBe('rooms_sweep')

    const custom = createEarthServer(deps, {
      routes: [
        {
          name: 'boom',
          method: 'GET',
          pattern: '/boom',
          handler: async () => {
            throw new Error('kaboom')
          },
        },
        {
          name: 'echo',
          method: 'GET',
          pattern: '/echo/:what',
          handler: async (_d, _r, params) => ok(params),
        },
      ],
    })
    const boom = await custom.handle(fakeRequest({ url: '/boom' }))
    expect(boom.status).toBe(500)
    expect(boom.body).toEqual({ error: { code: 'internal', message: 'internal' } })
    expect(logs.records.some((r) => r.level === 'error' && r.fields['route'] === 'boom')).toBe(true)
    const echo = await custom.handle(fakeRequest({ url: 'https://earth.social/echo/hello?x=1' }))
    expect(echo.body).toEqual({ what: 'hello' })
    const forbidden = createEarthServer(deps, {
      routes: [
        {
          name: 'f',
          method: 'GET',
          pattern: '/f',
          handler: async () => {
            throw new EarthError('blocked')
          },
        },
      ],
    })
    expect((await forbidden.handle(fakeRequest({ url: '/f' }))).status).toBe(403)
  })
})

describe('fetch adapter', () => {
  it('round-trips a Fetch Request through the server', async () => {
    const { deps } = createFakeDeps()
    const handler = createFetchHandler(createEarthServer(deps))
    const response = await handler(new Request('https://earth.social/api/health'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: SERVICE_NAME,
      now: TEST_NOW.toISOString(),
    })
  })

  it('reads the body once for both text() and json()', async () => {
    const request = new Request('https://earth.social/api/x', {
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json' },
    })
    const req = fromWebRequest(request)
    await expect(req.text()).resolves.toBe('{"a":1}')
    await expect(req.json()).resolves.toEqual({ a: 1 })
    await expect(req.text()).resolves.toBe('{"a":1}')
    expect(req.method).toBe('POST')
    const empty = fromWebRequest(new Request('https://earth.social/api/x', { method: 'POST' }))
    await expect(empty.json()).resolves.toBeUndefined()
  })

  it('toWebResponse keeps status, headers and JSON body', async () => {
    const response = toWebResponse({
      status: 405,
      headers: { allow: 'GET', 'content-type': 'application/json; charset=utf-8' },
      body: { error: { code: 'invalid_input', message: 'x' } },
    })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET')
    await expect(response.json()).resolves.toEqual({
      error: { code: 'invalid_input', message: 'x' },
    })
  })
})
