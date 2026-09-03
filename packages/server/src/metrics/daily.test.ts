import { describe, expect, it } from 'vitest'

import { handleMetricsDaily, previousUtcDay } from './daily'
import { CRON_SECRET_HEADER } from '../cron'
import { TEST_CRON_SECRET, TEST_NOW, createFakeDeps, fakeRequest } from '../test/fakes'

const headers = { [CRON_SECRET_HEADER]: TEST_CRON_SECRET }

describe('previousUtcDay', () => {
  it('returns the UTC day before, across month and year boundaries', () => {
    expect(previousUtcDay(TEST_NOW)).toBe('2026-09-02')
    expect(previousUtcDay(new Date('2026-03-01T00:30:00.000Z'))).toBe('2026-02-28')
    expect(previousUtcDay(new Date('2027-01-01T23:59:59.000Z'))).toBe('2026-12-31')
  })
})

describe('handleMetricsDaily', () => {
  it('is cron protected', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { metrics_compute_daily: () => null } })
    await expect(
      handleMetricsDaily(deps, fakeRequest({ method: 'POST', url: '/x' })),
    ).rejects.toMatchObject({ code: 'not_authenticated' })
    expect(supabase.calls).toHaveLength(0)
  })

  it('defaults to the previous UTC day and accepts day from body or query', async () => {
    const { deps, supabase } = createFakeDeps({
      rpc: { metrics_compute_daily: (args) => ({ day: args['day'], metrics: 12 }) },
    })
    const res = await handleMetricsDaily(
      deps,
      fakeRequest({ method: 'POST', url: '/api/internal/metrics/daily', headers }),
    )
    expect(res.body).toEqual({
      ok: true,
      day: '2026-09-02',
      result: { day: '2026-09-02', metrics: 12 },
    })
    await handleMetricsDaily(
      deps,
      fakeRequest({ method: 'POST', url: '/x?day=2026-08-01', headers }),
    )
    await handleMetricsDaily(
      deps,
      fakeRequest({
        method: 'POST',
        url: '/x?day=2026-08-01',
        headers,
        body: { day: '2026-07-04' },
      }),
    )
    expect(supabase.calls.map((c) => c.args['day'])).toEqual([
      '2026-09-02',
      '2026-08-01',
      '2026-07-04',
    ])
    expect(
      supabase.calls.every((c) => c.client === 'admin' && c.name === 'metrics_compute_daily'),
    ).toBe(true)
  })

  it('rejects a malformed day', async () => {
    const { deps } = createFakeDeps({ rpc: { metrics_compute_daily: () => null } })
    await expect(
      handleMetricsDaily(deps, fakeRequest({ method: 'POST', url: '/x?day=yesterday', headers })),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      handleMetricsDaily(
        deps,
        fakeRequest({ method: 'POST', url: '/x', headers, body: { day: '2026-13-01' } }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})
