import { ANALYTICS_INGEST_VERSION } from '@earth/analytics'
import { describe, expect, it } from 'vitest'

import { handleAnalyticsIngest } from './ingest'
import { TEST_NOW, createFakeDeps, fakeRequest, rpcFailure } from '../test/fakes'

const batch = {
  v: ANALYTICS_INGEST_VERSION,
  sentAt: '2026-09-03T11:59:59.000Z',
  events: [
    { name: 'public_world_viewed', properties: { platform: 'web', appVersion: '1.0.0' } },
    { name: 'feed_opened', properties: { scope: 'world', source: 'launch' } },
  ],
}

describe('handleAnalyticsIngest', () => {
  it('validates the batch and forwards it as the caller (visitor → anon client)', async () => {
    const { deps, supabase, analytics } = createFakeDeps({
      rpc: { analytics_track: () => ({ accepted: 2 }) },
    })
    const res = await handleAnalyticsIngest(
      deps,
      fakeRequest({ method: 'POST', url: '/api/analytics/ingest', body: batch }),
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ accepted: 2 })
    expect(supabase.calls[0]).toMatchObject({ client: 'anon', name: 'analytics_track' })
    expect(supabase.calls[0]?.args['events']).toEqual(batch.events)
    expect(analytics.batches[0]?.events).toEqual(batch.events)
    expect(analytics.batches[0]?.context).toEqual({ receivedAt: TEST_NOW.toISOString() })
  })

  it('forwards as the signed-in caller and tolerates RPCs returning nothing', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { analytics_track: () => null } })
    const res = await handleAnalyticsIngest(
      deps,
      fakeRequest({ method: 'POST', url: '/x', bearer: 'jwt', body: batch }),
    )
    expect(res.body).toEqual({ accepted: 2 })
    expect(supabase.calls[0]?.client).toBe('user:jwt')
  })

  it('rejects unknown events, GPS coordinates and oversized batches before touching the database', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { analytics_track: () => null } })
    const bad = [
      { ...batch, events: [{ name: 'made_up', properties: {} }] },
      { ...batch, events: [{ name: 'feed_opened', properties: { lat: 37.7, lng: -122.4 } }] },
      { ...batch, events: [] },
      { ...batch, v: 2 },
      'not json',
    ]
    for (const body of bad) {
      await expect(
        handleAnalyticsIngest(deps, fakeRequest({ method: 'POST', url: '/x', body })),
      ).rejects.toMatchObject({ code: 'invalid_input' })
    }
    expect(supabase.calls).toHaveLength(0)
  })

  it('surfaces the RPC rate limit and tolerates a failing vendor sink', async () => {
    const limited = createFakeDeps({
      rpc: {
        analytics_track: () => {
          throw rpcFailure('rate_limited')
        },
      },
    })
    await expect(
      handleAnalyticsIngest(limited.deps, fakeRequest({ method: 'POST', url: '/x', body: batch })),
    ).rejects.toMatchObject({ code: 'rate_limited' })

    const { deps, analytics, logs } = createFakeDeps({ rpc: { analytics_track: () => 2 } })
    analytics.fail = true
    const res = await handleAnalyticsIngest(
      deps,
      fakeRequest({ method: 'POST', url: '/x', body: batch }),
    )
    expect(res.status).toBe(200)
    expect(logs.records.some((r) => r.msg === 'analytics.sink_failed')).toBe(true)
  })
})
