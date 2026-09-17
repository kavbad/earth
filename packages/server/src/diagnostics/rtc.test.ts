import { describe, expect, it } from 'vitest'

import { handleRtcDiagnostics } from './rtc'
import { TEST_NOW, createFakeDeps, fakeRequest } from '../test/fakes'

const ROOM_ID = '22222222-2222-4222-8222-222222222222'

describe('handleRtcDiagnostics', () => {
  it('validates the envelope and records it as the caller', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { rtc_diagnostic_record: () => null } })
    const envelope = {
      v: 1,
      ts: '2026-09-03T11:59:00.000Z',
      event: {
        kind: 'connect_failed',
        roomId: ROOM_ID,
        attempt: 2,
        durationMs: 1234,
        reason: 'ice failed token=abc',
        unknown: 'dropped',
      },
    }
    const res = await handleRtcDiagnostics(
      deps,
      fakeRequest({ method: 'POST', url: '/api/diagnostics/rtc', bearer: 'jwt', body: envelope }),
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, kind: 'connect_failed' })
    const call = supabase.calls[0]
    expect(call).toMatchObject({
      client: 'user:jwt',
      name: 'rtc_diagnostic_record',
      args: { kind: 'connect_failed', room_id: ROOM_ID },
    })
    const payload = call?.args['payload'] as Record<string, unknown>
    expect(payload['attempt']).toBe(2)
    expect(payload['durationMs']).toBe(1234)
    expect(payload['ts']).toBe(envelope.ts)
    expect(payload['receivedAt']).toBe(TEST_NOW.toISOString())
    expect(payload).not.toHaveProperty('unknown')
    expect(payload).not.toHaveProperty('kind')
    expect(String(payload['reason'])).not.toContain('abc')
  })

  it('visitors and guests may post too (anon client), room_id null when absent', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { rtc_diagnostic_record: () => null } })
    await handleRtcDiagnostics(
      deps,
      fakeRequest({
        method: 'POST',
        url: '/x',
        body: {
          v: 1,
          ts: TEST_NOW.toISOString(),
          event: { kind: 'realtime_fallback', channel: 'conversation' },
        },
      }),
    )
    expect(supabase.calls[0]).toMatchObject({
      client: 'anon',
      args: { kind: 'realtime_fallback', room_id: null },
    })
  })

  it('rejects malformed envelopes without touching the database', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { rtc_diagnostic_record: () => null } })
    for (const body of [
      { v: 2, ts: TEST_NOW.toISOString(), event: { kind: 'connected' } },
      { v: 1, ts: 'yesterday', event: { kind: 'connected' } },
      { v: 1, ts: TEST_NOW.toISOString(), event: { kind: 'made_up' } },
      { v: 1, ts: TEST_NOW.toISOString(), event: { kind: 'connected', roomId: 'nope' } },
      'garbage',
    ]) {
      await expect(
        handleRtcDiagnostics(deps, fakeRequest({ method: 'POST', url: '/x', body })),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(supabase.calls).toHaveLength(0)
  })
})
