/**
 * Smoke test of the production wiring with the real SDKs (`@supabase/supabase-js`,
 * `expo-server-sdk`, `livekit-server-sdk`, `@sentry/nextjs`): constructing clients performs no
 * I/O, and the LiveKit `WebhookReceiver` rejects a garbage signature locally.
 */
import { SERVICE_NAME } from '@earth/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getServerContext, getServerDeps, productionWiringOptions, resetServerContext } from './deps'
import { TEST_CRON_SECRET, readJson, testEnvSource, webRequest } from './fakes'
import { makeRouteHandler } from './handler'

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
  setEnv({ ...testEnvSource(), SENTRY_DSN: undefined, EXPO_ACCESS_TOKEN: undefined, CRON_SECRET: undefined })
})

afterEach(() => {
  resetServerContext()
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

describe('getServerContext', () => {
  it('builds and memoises the context from process.env with the real SDKs', () => {
    const context = getServerContext()
    expect(getServerContext()).toBe(context)
    expect(getServerDeps()).toBe(context.deps)
    expect(context.monitorKind).toBe('noop')
    expect(context.deps.cronSecret).toBe(TEST_CRON_SECRET)
    expect(context.deps.verification.kind).toBe('mock')
    expect(typeof context.deps.supabaseAdmin.rpc).toBe('function')
    expect(typeof context.deps.supabaseForUser('token').rpc).toBe('function')
    resetServerContext()
    expect(getServerContext()).not.toBe(context)
  })

  it('does not cache a failed build', () => {
    setEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined })
    expect(() => getServerContext()).toThrow()
    setEnv({ SUPABASE_SERVICE_ROLE_KEY: 'service-role-key' })
    expect(getServerContext().deps.cronSecret).toBe(TEST_CRON_SECRET)
  })

  it('exposes the production factories', () => {
    const options = productionWiringOptions({})
    expect(options.source).toEqual({})
    expect(options.sentry).toBeDefined()
    const expo = options.createExpoClient('expo-token')
    expect(expo.chunkPushNotifications([])).toEqual([])
    const client = options.createSupabaseClient('http://localhost:54321', 'anon-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: {} },
    })
    expect(typeof client.rpc).toBe('function')
    expect(typeof client.from).toBe('function')
  })
})

describe('makeRouteHandler with the production context', () => {
  it('serves /api/health and rejects a garbage LiveKit webhook with 401', async () => {
    const handlers = makeRouteHandler()
    const health = await handlers.GET(webRequest('/api/health'))
    expect(health.status).toBe(200)
    expect(await readJson(health)).toMatchObject({ ok: true, service: SERVICE_NAME })

    const webhook = await handlers.POST(
      webRequest('/api/livekit/webhook', { method: 'POST', body: 'garbage', headers: { authorization: 'nonsense' } }),
    )
    expect(webhook.status).toBe(401)
    expect(await readJson(webhook)).toMatchObject({ error: { code: 'not_authenticated' } })

    const noBearer = await handlers.GET(webRequest('/api/feed?scope=friends'))
    expect(noBearer.status).toBe(401)
    const sweep = await handlers.POST(webRequest('/api/internal/rooms/sweep', { method: 'POST' }))
    expect(sweep.status).toBe(401)
  })
})
