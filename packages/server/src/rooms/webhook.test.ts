import { createHash } from 'node:crypto'

import { SignJWT, UnsecuredJWT } from 'jose'
import { AccessToken } from 'livekit-server-sdk'
import { describe, expect, it } from 'vitest'

import { handleLiveKitWebhook, isLiveKitSyncEvent, webhookEventAt } from './webhook'
import { TEST_LIVEKIT, TEST_NOW, createFakeDeps, fakeRequest, rpcFailure } from '../test/fakes'

const ROOM_ID = '22222222-2222-4222-8222-222222222222'
const HUMAN_ID = '11111111-1111-4111-8111-111111111111'
const AT_SECONDS = 1_756_900_000

/** Signs a webhook body exactly like LiveKit: a JWT under the API secret carrying the body sha256. */
async function sign(
  body: string,
  apiKey: string = TEST_LIVEKIT.apiKey,
  apiSecret: string = TEST_LIVEKIT.apiSecret,
): Promise<string> {
  const token = new AccessToken(apiKey, apiSecret, { ttl: '10m' })
  token.sha256 = createHash('sha256').update(body).digest('base64')
  return token.toJwt()
}

function event(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'participant_joined',
    id: 'EV_1',
    createdAt: AT_SECONDS,
    room: { name: ROOM_ID, sid: 'RM_1' },
    participant: { identity: `h:${HUMAN_ID}`, sid: 'PA_1' },
    ...overrides,
  })
}

async function post(body: string, authorization?: string) {
  return fakeRequest({
    method: 'POST',
    url: '/api/livekit/webhook',
    headers: authorization === undefined ? {} : { authorization },
    body,
  })
}

describe('handleLiveKitWebhook', () => {
  it('rejects a missing signature with 401', async () => {
    const { deps, supabase } = createFakeDeps()
    const res = await handleLiveKitWebhook(deps, await post(event()))
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ error: { code: 'not_authenticated' } })
    expect(supabase.calls).toHaveLength(0)
  })

  it('rejects a signature under another secret', async () => {
    const { deps, supabase } = createFakeDeps()
    const body = event()
    const res = await handleLiveKitWebhook(
      deps,
      await post(
        body,
        await sign(body, TEST_LIVEKIT.apiKey, 'other-secret-other-secret-other-secret'),
      ),
    )
    expect(res.status).toBe(401)
    expect(supabase.calls).toHaveLength(0)
  })

  it('rejects a valid signature over a different body', async () => {
    const { deps, supabase } = createFakeDeps()
    const res = await handleLiveKitWebhook(
      deps,
      await post(event({ id: 'EV_2' }), await sign(event({ id: 'EV_1' }))),
    )
    expect(res.status).toBe(401)
    expect(supabase.calls).toHaveLength(0)
  })

  it('accepts a correctly signed participant_joined and syncs it as the service', async () => {
    const { deps, supabase } = createFakeDeps({
      rpc: { room_participant_sync: () => ({ applied: true }) },
    })
    const body = event()
    const res = await handleLiveKitWebhook(deps, await post(body, await sign(body)))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, event: 'participant_joined', handled: true })
    expect(supabase.calls).toEqual([
      {
        client: 'admin',
        name: 'room_participant_sync',
        args: {
          room_id: ROOM_ID,
          livekit_identity: `h:${HUMAN_ID}`,
          event: 'participant_joined',
          at: new Date(AT_SECONDS * 1000).toISOString(),
        },
      },
    ])
  })

  it('maps participant_left and room_finished (no participant) too', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { room_participant_sync: () => null } })
    const left = event({ event: 'participant_left' })
    await handleLiveKitWebhook(deps, await post(left, await sign(left)))
    const finished = event({ event: 'room_finished', participant: undefined })
    const res = await handleLiveKitWebhook(deps, await post(finished, await sign(finished)))
    expect(res.status).toBe(200)
    expect(supabase.calls.map((c) => [c.args['event'], c.args['livekit_identity']])).toEqual([
      ['participant_left', `h:${HUMAN_ID}`],
      ['room_finished', null],
    ])
  })

  it('ignores events the sync RPC does not know and non-Earth rooms/identities', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { room_participant_sync: () => null } })
    for (const body of [
      event({ event: 'track_published' }),
      event({ room: { name: 'not-a-uuid', sid: 'RM' } }),
      event({ participant: { identity: 'someone-else', sid: 'PA' } }),
    ]) {
      const res = await handleLiveKitWebhook(deps, await post(body, await sign(body)))
      expect(res.status).toBe(200)
      expect(res.body).toMatchObject({ ok: true, handled: false })
    }
    expect(supabase.calls).toHaveLength(0)
  })

  it('answers 200 and logs when the sync RPC fails or reports an out-of-order event', async () => {
    const { deps, logs } = createFakeDeps({
      rpc: {
        room_participant_sync: () => {
          throw rpcFailure('room_not_found')
        },
      },
    })
    const body = event()
    const res = await handleLiveKitWebhook(deps, await post(body, await sign(body)))
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: false,
      event: 'participant_joined',
      handled: true,
      reason: 'room_not_found',
    })
    expect(logs.records.some((r) => r.msg === 'livekit.webhook_sync_failed')).toBe(true)

    const ooo = createFakeDeps({
      rpc: { room_participant_sync: () => ({ ignored: true, reason: 'out_of_order' }) },
    })
    const res2 = await handleLiveKitWebhook(ooo.deps, await post(body, await sign(body)))
    expect(res2.body).toMatchObject({ ok: true, handled: true, reason: 'out_of_order' })
    expect(ooo.logs.records.some((r) => r.msg === 'rtc.webhook_out_of_order')).toBe(true)
  })

  it('uses an injected receiver when provided', async () => {
    const { deps, supabase } = createFakeDeps({
      rpc: { room_participant_sync: () => null },
      livekit: {
        webhookReceiver: {
          receive: async (body, authHeader) => {
            if (authHeader !== 'trusted') throw new Error('bad')
            return JSON.parse(body) as {
              event: string
              room: { name: string }
              participant: { identity: string }
            }
          },
        },
      },
    })
    const ok = await handleLiveKitWebhook(
      deps,
      await post(event({ createdAt: undefined }), 'trusted'),
    )
    expect(ok.status).toBe(200)
    const bad = await handleLiveKitWebhook(
      deps,
      await post(event({ createdAt: undefined }), 'untrusted'),
    )
    expect(bad.status).toBe(401)
    expect(supabase.calls).toHaveLength(1)
    // Without createdAt the injected clock is used.
    expect(supabase.calls[0]?.args['at']).toBe(TEST_NOW.toISOString())
  })

  it('helpers', () => {
    expect(isLiveKitSyncEvent('participant_joined')).toBe(true)
    expect(isLiveKitSyncEvent('room_started')).toBe(false)
    expect(webhookEventAt({ event: 'x', createdAt: BigInt(AT_SECONDS) }, TEST_NOW)).toBe(
      new Date(AT_SECONDS * 1000).toISOString(),
    )
    expect(webhookEventAt({ event: 'x', createdAt: 0 }, TEST_NOW)).toBe(TEST_NOW.toISOString())
    expect(webhookEventAt({ event: 'x' }, TEST_NOW)).toBe(TEST_NOW.toISOString())
  })
})

describe('adversarial: signature is verified over the raw body under our key', () => {
  const secretBytes = new TextEncoder().encode(TEST_LIVEKIT.apiSecret)
  const sha256Of = (body: string) => createHash('sha256').update(body).digest('base64')

  it('rejects a signature issued under another API key even with our secret', async () => {
    const { deps, supabase } = createFakeDeps()
    const body = event()
    const res = await handleLiveKitWebhook(
      deps,
      await post(body, await sign(body, 'other-key', TEST_LIVEKIT.apiSecret)),
    )
    expect(res.status).toBe(401)
    expect(supabase.calls).toHaveLength(0)
  })

  it('rejects an expired signature', async () => {
    const { deps, supabase } = createFakeDeps()
    const body = event()
    const expired = await new SignJWT({ sha256: sha256Of(body) })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TEST_LIVEKIT.apiKey)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 120)
      .sign(secretBytes)
    const res = await handleLiveKitWebhook(deps, await post(body, expired))
    expect(res.status).toBe(401)
    expect(supabase.calls).toHaveLength(0)
  })

  it('rejects an unsigned (alg none) token carrying the right body hash', async () => {
    const { deps, supabase } = createFakeDeps()
    const body = event()
    const unsecured = new UnsecuredJWT({ sha256: sha256Of(body) })
      .setIssuer(TEST_LIVEKIT.apiKey)
      .setExpirationTime('10m')
      .encode()
    const res = await handleLiveKitWebhook(deps, await post(body, unsecured))
    expect(res.status).toBe(401)
    expect(supabase.calls).toHaveLength(0)
  })

  it('rejects a body that was re-serialised (same JSON, different bytes)', async () => {
    const { deps, supabase } = createFakeDeps()
    const compact = event()
    const pretty = JSON.stringify(JSON.parse(compact), null, 2)
    expect(JSON.parse(pretty)).toEqual(JSON.parse(compact))
    const res = await handleLiveKitWebhook(deps, await post(pretty, await sign(compact)))
    expect(res.status).toBe(401)
    expect(supabase.calls).toHaveLength(0)
  })

  it('a valid signature never lets the event reach the database before verification', async () => {
    const calls: string[] = []
    const { deps, supabase } = createFakeDeps({
      rpc: {
        room_participant_sync: () => {
          calls.push('sync')
          return null
        },
      },
    })
    const body = event({ event: 'room_finished', participant: undefined })
    // Tampered: the signed body ends a different room.
    const tampered = event({
      event: 'room_finished',
      participant: undefined,
      room: { name: '99999999-9999-4999-8999-999999999999', sid: 'RM_9' },
    })
    const res = await handleLiveKitWebhook(deps, await post(tampered, await sign(body)))
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
    expect(supabase.calls).toHaveLength(0)
  })
})
