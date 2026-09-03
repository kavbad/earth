import { createHash, createHmac } from 'node:crypto'

import { EnvError } from '@earth/config'
import type { MediaGrantDto, RoomId } from '@earth/domain'
import {
  ALLOW_HEADER,
  CRON_SECRET_HEADER,
  type EarthServer,
  HUMAN_PASS_RECORD_RESULT_RPC,
  JSON_CONTENT_TYPE,
  ROOM_MEDIA_GRANT_RPC,
  ROOM_PARTICIPANT_SYNC_RPC,
  SERVICE_NAME,
  isErrorBody,
} from '@earth/server'
import { createMemorySink, createLogger, createRecordingMonitor } from '@earth/observability'
import { AccessToken } from 'livekit-server-sdk'
import { describe, expect, it } from 'vitest'

import {
  TEST_CRON_SECRET,
  TEST_NOW,
  TEST_VERCEL_CRON_SECRET,
  type TestContext,
  createTestContext,
  readJson,
  webRequest,
} from './fakes'
import { CONTEXT_FAILED_LOG_MESSAGE, ROUTE_TAG, makeRouteHandler } from './handler'
import type { WebServerContext } from './wiring'

const SWEEP = '/api/internal/rooms/sweep'
const SWEEP_RESULT = { roomsEnded: 1, guestsExpired: 0 }
const ROOM_ID = '11111111-1111-4111-8111-111111111111' as RoomId
const HUMAN_ID = '22222222-2222-4222-8222-222222222222'
const IDENTITY = `h:${HUMAN_ID}`
const USER_JWT = 'user.jwt'

/** Signs a webhook body exactly like LiveKit: a JWT under the API secret carrying the body sha256. */
async function signLiveKit(body: string, apiKey = 'devkey', apiSecret = 'secret'): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, { ttl: '10m' })
  token.sha256 = createHash('sha256').update(body).digest('base64')
  return token.toJwt()
}

function jwtPayload(token: string): Record<string, unknown> {
  const [, payload = ''] = token.split('.')
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
}

function handlerFor(test: TestContext) {
  return makeRouteHandler({ context: () => test.context })
}

async function errorCode(response: Response): Promise<string> {
  const body = await readJson(response)
  if (!isErrorBody(body)) throw new Error(`not an error body: ${JSON.stringify(body)}`)
  return body.error.code
}

describe('makeRouteHandler', () => {
  it('serves the router health route as JSON', async () => {
    const test = createTestContext()
    const response = await handlerFor(test).GET(webRequest('/api/health'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE)
    await expect(readJson(response)).resolves.toEqual({
      ok: true,
      service: SERVICE_NAME,
      now: TEST_NOW.toISOString(),
    })
  })

  it('answers 401 not_authenticated for GET /api/feed?scope=friends without a bearer', async () => {
    const test = createTestContext()
    const response = await handlerFor(test).GET(webRequest('/api/feed?scope=friends'))
    expect(response.status).toBe(401)
    await expect(errorCode(response)).resolves.toBe('not_authenticated')
    expect(test.supabase.calls).toEqual([])
  })

  it('answers 401 for POST /api/rooms/:id/token without a bearer', async () => {
    const test = createTestContext()
    const response = await handlerFor(test).POST(
      webRequest('/api/rooms/abc/token', { method: 'POST' }),
    )
    expect(response.status).toBe(401)
    await expect(errorCode(response)).resolves.toBe('not_authenticated')
  })

  it('answers 401 for an internal route without a cron secret', async () => {
    const test = createTestContext({ rpc: { rooms_sweep: () => SWEEP_RESULT } })
    const response = await handlerFor(test).POST(webRequest(SWEEP, { method: 'POST' }))
    expect(response.status).toBe(401)
    await expect(errorCode(response)).resolves.toBe('not_authenticated')
    expect(test.supabase.callsTo('rooms_sweep')).toEqual([])
  })

  it('runs an internal route with x-earth-cron-secret on the service-role client', async () => {
    const test = createTestContext({ rpc: { rooms_sweep: () => SWEEP_RESULT } })
    const response = await handlerFor(test).POST(
      webRequest(SWEEP, { method: 'POST', headers: { [CRON_SECRET_HEADER]: TEST_CRON_SECRET } }),
    )
    expect(response.status).toBe(200)
    await expect(readJson(response)).resolves.toEqual({
      ok: true,
      ranAt: TEST_NOW.toISOString(),
      result: SWEEP_RESULT,
    })
    expect(test.supabase.callsTo('rooms_sweep')).toEqual([
      { kind: 'admin', name: 'rooms_sweep', args: {} },
    ])
  })

  it('accepts a Vercel cron GET carrying the CRON_SECRET bearer', async () => {
    const test = createTestContext({
      env: { CRON_SECRET: TEST_VERCEL_CRON_SECRET },
      rpc: { rooms_sweep: () => SWEEP_RESULT },
    })
    const response = await handlerFor(test).GET(webRequest(SWEEP, { bearer: TEST_VERCEL_CRON_SECRET }))
    expect(response.status).toBe(200)
    expect(test.supabase.callsTo('rooms_sweep')).toHaveLength(1)
  })

  it('accepts INTERNAL_CRON_SECRET itself as the bearer when CRON_SECRET is unset', async () => {
    const test = createTestContext({ rpc: { rooms_sweep: () => SWEEP_RESULT } })
    const response = await handlerFor(test).GET(webRequest(SWEEP, { bearer: TEST_CRON_SECRET }))
    expect(response.status).toBe(200)
  })

  it('rejects a wrong cron bearer with 403 and a bare GET with 405', async () => {
    const test = createTestContext({
      env: { CRON_SECRET: TEST_VERCEL_CRON_SECRET },
      rpc: { rooms_sweep: () => SWEEP_RESULT },
    })
    const forbidden = await handlerFor(test).GET(webRequest(SWEEP, { bearer: 'nope' }))
    expect(forbidden.status).toBe(403)
    await expect(errorCode(forbidden)).resolves.toBe('forbidden')
    const bare = await handlerFor(test).GET(webRequest(SWEEP))
    expect(bare.status).toBe(405)
    expect(bare.headers.get(ALLOW_HEADER)).toBe('POST')
    expect(test.supabase.callsTo('rooms_sweep')).toEqual([])
  })

  it('answers 401 for a LiveKit webhook whose signature does not verify, passing the raw body', async () => {
    const received: { body: string; auth: string | undefined }[] = []
    const test = createTestContext({
      webhookReceiver: {
        receive: async (body, authHeader) => {
          received.push({ body, auth: authHeader })
          throw new Error('invalid signature')
        },
      },
    })
    const raw = '{"garbage": true, "trailing": "  spaces  "}'
    const response = await handlerFor(test).POST(
      webRequest('/api/livekit/webhook', { method: 'POST', body: raw, headers: { authorization: 'nonsense' } }),
    )
    expect(response.status).toBe(401)
    await expect(errorCode(response)).resolves.toBe('not_authenticated')
    expect(received).toEqual([{ body: raw, auth: 'nonsense' }])
  })

  it('answers 404 not_visible for an unknown route', async () => {
    const test = createTestContext()
    const response = await handlerFor(test).DELETE(
      webRequest('/api/nothing/here', { method: 'DELETE' }),
    )
    expect(response.status).toBe(404)
    await expect(errorCode(response)).resolves.toBe('not_visible')
  })

  it('answers 500 internal JSON when the context cannot be built, logging the cause', async () => {
    const logs = createMemorySink()
    const handlers = makeRouteHandler({
      context: () => {
        throw new EnvError('server', [{ variable: 'SUPABASE_SERVICE_ROLE_KEY', message: 'missing' }])
      },
      fallbackLogger: createLogger({ sink: logs.sink }),
    })
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
      const response = await handlers[method](webRequest('/api/health', { method }))
      expect(response.status).toBe(500)
      const body = await readJson(response)
      expect(body).toEqual({ error: { code: 'internal', message: 'internal' } })
    }
    expect(logs.records[0]?.msg).toBe(CONTEXT_FAILED_LOG_MESSAGE)
    expect(logs.records[0]?.fields).toMatchObject({ error: { name: 'EnvError' } })
    expect(JSON.stringify(logs.records)).not.toContain('service-role')
  })

  it('captures anything that escapes the router and still answers JSON', async () => {
    const test = createTestContext()
    const recording = createRecordingMonitor()
    const broken: EarthServer = {
      routes: test.context.server.routes,
      handle: async () => {
        throw new TypeError('adapter bug')
      },
    }
    const context: WebServerContext = { ...test.context, server: broken, monitor: recording.monitor }
    const response = await makeRouteHandler({ context: () => context }).GET(webRequest('/api/health'))
    expect(response.status).toBe(500)
    await expect(errorCode(response)).resolves.toBe('internal')
    expect(recording.calls).toHaveLength(1)
    expect(recording.calls[0]).toMatchObject({
      method: 'captureException',
      context: { tags: { [ROUTE_TAG]: '/api/health' } },
    })
    expect(test.logs.records.some((r) => r.level === 'error')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Every route end to end: real signature checks, the right Supabase client per caller kind
  // -------------------------------------------------------------------------

  it('serves GET /api/feed?scope=world to a Visitor through the anon client', async () => {
    const test = createTestContext({ rpc: { feed_candidates: () => [] } })
    const response = await handlerFor(test).GET(webRequest('/api/feed?scope=world'))
    expect(response.status).toBe(200)
    await expect(readJson(response)).resolves.toEqual({
      cards: [],
      nextCursor: null,
      snapshotAt: TEST_NOW.toISOString(),
      scope: 'world',
      areaName: null,
    })
    expect(test.supabase.calls).toEqual([
      {
        kind: 'anon',
        name: 'feed_candidates',
        args: { scope: 'world', area_id: null, snapshot_at: TEST_NOW.toISOString(), limit: 200 },
      },
    ])
  })

  it('mints a LiveKit token for POST /api/rooms/:id/token from the grant made as the caller', async () => {
    const grant: MediaGrantDto = {
      livekitRoom: ROOM_ID,
      identity: IDENTITY,
      name: 'Xavier',
      role: 'participant',
      canPublish: false,
      canSubscribe: true,
      canPublishData: true,
      ttlSeconds: 7200,
    }
    const test = createTestContext({ rpc: { [ROOM_MEDIA_GRANT_RPC]: () => grant } })
    const response = await handlerFor(test).POST(
      webRequest(`/api/rooms/${ROOM_ID}/token`, { method: 'POST', bearer: USER_JWT }),
    )
    expect(response.status).toBe(200)
    const body = (await readJson(response)) as { token: string; url: string; identity: string; expiresAt: string }
    expect(body).toMatchObject({
      url: 'ws://localhost:7880',
      identity: IDENTITY,
      expiresAt: new Date(TEST_NOW.getTime() + 7200 * 1000).toISOString(),
    })
    expect(test.supabase.calls).toEqual([
      { kind: `user:${USER_JWT}`, name: ROOM_MEDIA_GRANT_RPC, args: { room_id: ROOM_ID } },
    ])
    // Claims come only from the grant: no publish right, no admin right.
    const claims = jwtPayload(body.token)
    expect(claims['iss']).toBe('devkey')
    expect(claims['sub']).toBe(IDENTITY)
    expect(claims['video']).toMatchObject({
      room: ROOM_ID,
      roomJoin: true,
      canPublish: false,
      canSubscribe: true,
      roomAdmin: false,
    })
  })

  it('accepts a LiveKit webhook signed under the API secret over the raw body and syncs as service', async () => {
    const calls: unknown[] = []
    const test = createTestContext({
      rpc: {
        [ROOM_PARTICIPANT_SYNC_RPC]: (args) => {
          calls.push(args)
          return { ok: true }
        },
      },
    })
    const body = JSON.stringify({
      event: 'participant_joined',
      id: 'EV_1',
      createdAt: 1756900000,
      room: { name: ROOM_ID, sid: 'RM_x' },
      participant: { identity: IDENTITY, sid: 'PA_x' },
    })
    const authorization = await signLiveKit(body)
    const handlers = handlerFor(test)

    const accepted = await handlers.POST(
      webRequest('/api/livekit/webhook', {
        method: 'POST',
        body,
        headers: { authorization, 'content-type': 'application/webhook+json' },
      }),
    )
    expect(accepted.status).toBe(200)
    await expect(readJson(accepted)).resolves.toEqual({
      ok: true,
      event: 'participant_joined',
      handled: true,
    })
    expect(test.supabase.callsTo(ROOM_PARTICIPANT_SYNC_RPC).map((c) => c.kind)).toEqual(['admin'])
    expect(calls).toEqual([
      {
        room_id: ROOM_ID,
        livekit_identity: IDENTITY,
        event: 'participant_joined',
        at: new Date(1756900000 * 1000).toISOString(),
      },
    ])

    // The same signature over a body that differs by one byte is refused before any RPC.
    const tampered = await handlers.POST(
      webRequest('/api/livekit/webhook', {
        method: 'POST',
        body: `${body} `,
        headers: { authorization, 'content-type': 'application/webhook+json' },
      }),
    )
    expect(tampered.status).toBe(401)
    await expect(errorCode(tampered)).resolves.toBe('not_authenticated')

    // A token signed with another secret is refused too.
    const foreign = await handlers.POST(
      webRequest('/api/livekit/webhook', {
        method: 'POST',
        body,
        headers: { authorization: await signLiveKit(body, 'devkey', 'other-secret') },
      }),
    )
    expect(foreign.status).toBe(401)
    expect(calls).toHaveLength(1)
  })

  it('verifies a vendor verification webhook by HMAC over the raw body and records the result', async () => {
    const secret = 'whsec-0123456789'
    const recorded: unknown[] = []
    const test = createTestContext({
      env: {
        HUMAN_VERIFICATION_PROVIDER: 'vendor',
        HUMAN_VERIFICATION_VENDOR_URL: 'https://verify.example',
        HUMAN_VERIFICATION_VENDOR_KEY: 'vendor-key',
        HUMAN_VERIFICATION_WEBHOOK_SECRET: secret,
      },
      rpc: {
        [HUMAN_PASS_RECORD_RESULT_RPC]: (args) => {
          recorded.push(args)
          return null
        },
      },
    })
    expect(test.context.deps.verification.kind).toBe('vendor')
    const body = JSON.stringify({ id: 'sess-1', status: 'approved', subject_id: HUMAN_ID, extra: '  ' })
    const signature = createHmac('sha256', secret).update(body).digest('hex')
    const handlers = handlerFor(test)

    const accepted = await handlers.POST(
      webRequest('/api/claim/verification/webhook', {
        method: 'POST',
        body,
        headers: { 'x-signature': `v1=${signature}` },
      }),
    )
    expect(accepted.status).toBe(200)
    await expect(readJson(accepted)).resolves.toEqual({ ok: true, recorded: true, sessionId: 'sess-1' })
    expect(test.supabase.callsTo(HUMAN_PASS_RECORD_RESULT_RPC).map((c) => c.kind)).toEqual(['admin'])
    expect(recorded[0]).toMatchObject({
      human_id: HUMAN_ID,
      status: 'verified',
      provider: 'vendor',
      provider_reference: 'sess-1',
    })

    // Re-serialised JSON (same document, different bytes) must not verify: the raw text is signed.
    const reserialised = JSON.stringify(JSON.parse(body), null, 2)
    const tampered = await handlers.POST(
      webRequest('/api/claim/verification/webhook', {
        method: 'POST',
        body: reserialised,
        headers: { 'x-signature': `v1=${signature}` },
      }),
    )
    expect(tampered.status).toBe(403)
    await expect(errorCode(tampered)).resolves.toBe('forbidden')
    expect(recorded).toHaveLength(1)
  })

  it('answers the router JSON 405 with Allow for PUT, which no route defines', async () => {
    const test = createTestContext()
    const response = await handlerFor(test).PUT(webRequest('/api/feed', { method: 'PUT' }))
    expect(response.status).toBe(405)
    expect(response.headers.get(ALLOW_HEADER)).toBe('GET')
    expect(response.headers.get('content-type')).toBe(JSON_CONTENT_TYPE)
    await expect(errorCode(response)).resolves.toBe('invalid_input')
  })

  it('never forwards a cron bearer to Supabase as a session', async () => {
    const test = createTestContext({ rpc: { rooms_sweep: () => SWEEP_RESULT } })
    const response = await handlerFor(test).POST(
      webRequest(SWEEP, { method: 'POST', bearer: TEST_CRON_SECRET }),
    )
    expect(response.status).toBe(200)
    // The service-role client ran the sweep; no per-user client was created for the bearer.
    expect(test.supabase.callsTo('rooms_sweep').map((c) => c.kind)).toEqual(['admin'])
    expect(test.supabase.creations.some((c) => c.kind.startsWith('user:'))).toBe(false)
  })
})
