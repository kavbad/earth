/** The route over `process.env`, like `next start` runs it (no network: clients are only built). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetServerContext } from '../../../lib/server/deps'
import { testEnvSource } from '../../../lib/server/fakes'
import { GET, SERVICE_NAME, dynamic, runtime } from './route'

const saved = new Map<string, string | undefined>()

function setEnv(values: Readonly<Record<string, string | undefined>>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!saved.has(key)) saved.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

beforeEach(() => {
  resetServerContext()
  setEnv({ ...testEnvSource(), SENTRY_DSN: undefined, EXPO_ACCESS_TOKEN: undefined })
})

afterEach(() => {
  resetServerContext()
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

describe('GET /api/health', () => {
  it('runs on the Node runtime, always dynamically', () => {
    expect(runtime).toBe('nodejs')
    expect(dynamic).toBe('force-dynamic')
  })

  it('reports ready when the server environment validates', async () => {
    const response = GET()
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: SERVICE_NAME,
      serverTier: 'ready',
    })
  })

  it('fails fast with 503 and the variable names when the environment is invalid', async () => {
    setEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined, NEXT_PUBLIC_MAP_STYLE_URL: 'nope' })
    const response = GET()
    expect(response.status).toBe(503)
    const body = (await response.json()) as { issues: string[]; serverTier: string; ok: boolean }
    expect(body.ok).toBe(false)
    expect(body.serverTier).toBe('misconfigured')
    expect(body.issues).toEqual(
      expect.arrayContaining(['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_MAP_STYLE_URL']),
    )
    // Fixed environment, next probe: no restart needed.
    setEnv({
      SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
      NEXT_PUBLIC_MAP_STYLE_URL: 'https://demotiles.maplibre.org/style.json',
    })
    expect(GET().status).toBe(200)
  })
})
