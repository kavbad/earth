import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import {
  PACKAGE_NAME,
  PUSH_DISABLED_MESSAGE,
  type SupabaseClientFactory,
  type SupabaseClientOptionsLike,
  type SupabaseRpcClient,
  createServerDepsFromEnv,
} from './index'
import { FakeVerificationProvider, testServerEnv } from './test/fakes'

// Compile-time proof that supabase-js satisfies the structural client and factory types.
const _clientIsRpcClient: (client: SupabaseClient) => SupabaseRpcClient = (client) => client
const _factory: SupabaseClientFactory = createClient
void _clientIsRpcClient
void _factory

interface FactoryCall {
  url: string
  key: string
  options: SupabaseClientOptionsLike
}

describe('@earth/server', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('@earth/server')
  })

  it('createServerDepsFromEnv wires service, anon and per-user clients from the env', async () => {
    const calls: FactoryCall[] = []
    const env = testServerEnv()
    const provider = new FakeVerificationProvider()
    let factoryEnv: unknown
    const deps = createServerDepsFromEnv({
      env,
      supabase: { url: 'http://localhost:54321', anonKey: 'anon-key' },
      createSupabaseClient: (url, key, options) => {
        calls.push({ url, key, options })
        return { rpc: async () => ({ data: null, error: null }) }
      },
      verification: (e) => {
        factoryEnv = e
        return provider
      },
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({
      url: 'http://localhost:54321',
      key: env.SUPABASE_SERVICE_ROLE_KEY,
      options: {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: {} },
      },
    })
    expect(calls[1]).toMatchObject({ key: 'anon-key', options: { global: { headers: {} } } })

    deps.supabaseForUser('user.jwt.token')
    expect(calls[2]).toMatchObject({
      key: 'anon-key',
      options: { global: { headers: { Authorization: 'Bearer user.jwt.token' } } },
    })

    expect(factoryEnv).toBe(env)
    expect(deps.verification).toBe(provider)
    expect(deps.livekit).toEqual({
      apiKey: env.LIVEKIT_API_KEY,
      apiSecret: env.LIVEKIT_API_SECRET,
      url: env.LIVEKIT_URL,
      webhookReceiver: undefined,
    })
    expect(deps.cronSecret).toBe(env.INTERNAL_CRON_SECRET)
    expect(deps.env).toBe(env)
    expect(deps.now()).toBeInstanceOf(Date)
    // No Expo client → push disabled (non-transient refusals).
    const tickets = await deps.push.send([
      { to: 'ExponentPushToken[x]', title: 't', body: 'b', data: {}, priority: 'high' },
    ])
    expect(tickets[0]).toMatchObject({ status: 'error', message: PUSH_DISABLED_MESSAGE })
    await expect(deps.analytics.ingest([], { receivedAt: 'now' })).resolves.toBeUndefined()
  })

  it('uses the Expo client and explicit overrides when given', async () => {
    const sent: unknown[] = []
    const now = new Date('2026-01-01T00:00:00.000Z')
    const deps = createServerDepsFromEnv({
      env: testServerEnv(),
      supabase: { url: 'http://localhost:54321', anonKey: 'anon-key' },
      createSupabaseClient: () => ({ rpc: async () => ({ data: null, error: null }) }),
      verification: new FakeVerificationProvider(),
      expoClient: {
        chunkPushNotifications: (messages) => [messages],
        sendPushNotificationsAsync: async (messages) => {
          sent.push(...messages)
          return messages.map(() => ({ status: 'ok' as const, id: 'r' }))
        },
      },
      now: () => now,
      webhookReceiver: { receive: async () => ({ event: 'room_started' }) },
    })
    const tickets = await deps.push.send([
      { to: 'ExponentPushToken[x]', title: 't', body: 'b', data: {}, priority: 'high' },
    ])
    expect(tickets).toEqual([{ status: 'ok', id: 'r' }])
    expect(sent).toHaveLength(1)
    expect(deps.now()).toBe(now)
    expect(deps.livekit.webhookReceiver).toBeDefined()
  })
})
