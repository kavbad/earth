import { describe, expect, it } from 'vitest'

import { handleRoomsSweep } from './sweep'
import { CRON_SECRET_HEADER } from '../cron'
import { TEST_CRON_SECRET, TEST_NOW, createFakeDeps, fakeRequest } from '../test/fakes'

describe('handleRoomsSweep', () => {
  it('is cron protected', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { rooms_sweep: () => ({ endedRooms: 1 }) } })
    await expect(
      handleRoomsSweep(deps, fakeRequest({ method: 'POST', url: '/api/internal/rooms/sweep' })),
    ).rejects.toMatchObject({ code: 'not_authenticated' })
    await expect(
      handleRoomsSweep(
        deps,
        fakeRequest({ method: 'POST', url: '/x', headers: { [CRON_SECRET_HEADER]: 'wrong' } }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(supabase.calls).toHaveLength(0)
  })

  it('runs rooms_sweep as the service and returns its counts', async () => {
    const { deps, supabase } = createFakeDeps({
      rpc: { rooms_sweep: () => ({ endedRooms: 2, expiredGuests: 3 }) },
    })
    const res = await handleRoomsSweep(
      deps,
      fakeRequest({
        method: 'POST',
        url: '/x',
        headers: { [CRON_SECRET_HEADER]: TEST_CRON_SECRET },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      ranAt: TEST_NOW.toISOString(),
      result: { endedRooms: 2, expiredGuests: 3 },
    })
    expect(supabase.calls).toEqual([{ client: 'admin', name: 'rooms_sweep', args: {} }])
  })
})
