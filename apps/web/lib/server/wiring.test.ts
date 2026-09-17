import { EnvError } from '@earth/config'
import type { HumanId } from '@earth/domain'
import { PUSH_DISABLED_MESSAGE } from '@earth/server'
import { describe, expect, it } from 'vitest'

import {
  TEST_ANON_KEY,
  TEST_CRON_SECRET,
  TEST_LIVEKIT,
  TEST_NOW,
  TEST_SERVICE_KEY,
  TEST_SUPABASE_URL,
  TEST_VERCEL_CRON_SECRET,
  createFakeExpo,
  createFakeSentry,
  createFakeSupabase,
  createTestContext,
  testEnvSource,
} from './fakes'
import { createWebServerContext } from './wiring'

const PUSH_MESSAGE = {
  to: 'ExponentPushToken[x]',
  title: 't',
  body: 'b',
  data: {},
  priority: 'high',
} as const

describe('createWebServerContext', () => {
  it('wires service-role, anon and per-user Supabase clients from the environment', () => {
    const { context, supabase } = createTestContext()
    // Review store + ServerDeps admin (service role), then the anon client.
    expect(supabase.creations.map((c) => c.kind)).toEqual(['admin', 'admin', 'anon'])
    expect(supabase.creations[0]).toEqual({
      url: TEST_SUPABASE_URL,
      key: TEST_SERVICE_KEY,
      kind: 'admin',
    })
    expect(supabase.creations[2]).toEqual({
      url: TEST_SUPABASE_URL,
      key: TEST_ANON_KEY,
      kind: 'anon',
    })
    context.deps.supabaseForUser('user.jwt')
    expect(supabase.creations[3]).toEqual({
      url: TEST_SUPABASE_URL,
      key: TEST_ANON_KEY,
      kind: 'user:user.jwt',
    })
    expect(context.deps.livekit).toMatchObject(TEST_LIVEKIT)
    expect(context.deps.cronSecret).toBe(TEST_CRON_SECRET)
    expect(context.deps.now()).toBe(TEST_NOW)
    expect(context.deps.verification.kind).toBe('mock')
    expect(context.cron).toEqual({ internalSecret: TEST_CRON_SECRET, vercelCronSecret: undefined })
    expect(context.server.routes.length).toBeGreaterThan(0)
  })

  it('reads CRON_SECRET for the Vercel cron bearer', () => {
    const { context } = createTestContext({ env: { CRON_SECRET: TEST_VERCEL_CRON_SECRET } })
    expect(context.cron.vercelCronSecret).toBe(TEST_VERCEL_CRON_SECRET)
  })

  it('disables push without EXPO_ACCESS_TOKEN and builds the Expo client with it', async () => {
    const without = createTestContext()
    expect(without.expo.tokens).toEqual([])
    const tickets = await without.context.deps.push.send([PUSH_MESSAGE])
    expect(tickets[0]).toMatchObject({ status: 'error', message: PUSH_DISABLED_MESSAGE })

    const withToken = createTestContext({ env: { EXPO_ACCESS_TOKEN: 'expo-token' } })
    expect(withToken.expo.tokens).toEqual(['expo-token'])
    await expect(withToken.context.deps.push.send([PUSH_MESSAGE])).resolves.toEqual([
      { status: 'ok', id: 'receipt-0' },
    ])
    expect(withToken.expo.sent).toHaveLength(1)
  })

  it('uses the no-op monitor without SENTRY_DSN', () => {
    const { context, sentry } = createTestContext()
    expect(context.monitorKind).toBe('noop')
    expect(sentry.inits).toEqual([])
    context.logger.error('server.request_failed', { code: 'internal' })
    expect(sentry.messages).toEqual([])
  })

  it('initialises Sentry with SENTRY_DSN and forwards error logs to it', () => {
    const { context, sentry, logs } = createTestContext({
      env: { SENTRY_DSN: 'https://key@sentry.example/1', VERCEL_GIT_COMMIT_SHA: 'abc1234' },
    })
    expect(context.monitorKind).toBe('sentry')
    expect(sentry.inits).toEqual([
      {
        dsn: 'https://key@sentry.example/1',
        environment: 'development',
        release: context.env.release,
        sendDefaultPii: false,
      },
    ])
    expect(context.env.release).toMatch(/^earth-web@.+\+abc1234$/)
    context.logger.info('quiet')
    context.logger.error('server.request_failed', { code: 'internal', status: 500 })
    expect(logs.records.map((r) => r.msg)).toEqual(['quiet', 'server.request_failed'])
    expect(logs.records[1]?.fields).toMatchObject({
      service: 'earth-web',
      release: context.env.release,
    })
    expect(sentry.messages).toHaveLength(1)
    expect(sentry.messages[0]).toMatchObject({
      message: 'server.request_failed',
      context: { level: 'error', tags: { code: 'internal' } },
    })
  })

  it('honours LOG_LEVEL', () => {
    const { context, logs } = createTestContext({ env: { LOG_LEVEL: 'warn' } })
    context.logger.info('hidden')
    context.logger.warn('shown')
    expect(logs.records.map((r) => r.msg)).toEqual(['shown'])
  })

  it('wires the manual-review provider over the service-role review store', async () => {
    const { context, supabase } = createTestContext({
      env: { HUMAN_VERIFICATION_PROVIDER: 'manual_review' },
    })
    expect(context.deps.verification.kind).toBe('manual_review')
    const session = await context.deps.verification.startVerification({
      humanId: '11111111-1111-4111-8111-111111111111' as HumanId,
      humanPassId: 'pass-1',
      locale: 'en-US',
      platform: 'web',
    })
    expect(session.sessionId).toBe('review-1')
    expect(supabase.reviews).toHaveLength(1)
  })

  it('fails loudly on an invalid environment', () => {
    const supabase = createFakeSupabase()
    expect(() =>
      createWebServerContext({
        source: testEnvSource({ SUPABASE_SERVICE_ROLE_KEY: '' }),
        createSupabaseClient: supabase.factory,
        createExpoClient: createFakeExpo().factory,
        sentry: createFakeSentry().sdk,
      }),
    ).toThrow(EnvError)
    expect(supabase.creations).toEqual([])
  })
})
