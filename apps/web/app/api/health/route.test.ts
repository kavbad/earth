import { describe, expect, it } from 'vitest'

import { GET, SERVICE_NAME } from './route'

describe('GET /api/health', () => {
  it('reports the web service as healthy', async () => {
    const response = GET()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, service: SERVICE_NAME })
  })
})
