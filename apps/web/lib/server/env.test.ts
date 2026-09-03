import { EnvError } from '@earth/config'
import { describe, expect, it } from 'vitest'

import {
  LOG_LEVEL_VARIABLE,
  VERCEL_COMMIT_VARIABLE,
  VERCEL_CRON_SECRET_VARIABLE,
  WEB_APP_NAME,
  WEB_APP_VERSION,
  loadWebServerEnv,
  releaseFor,
} from './env'
import { TEST_ANON_KEY, TEST_CRON_SECRET, TEST_SUPABASE_URL, testEnvSource } from './fakes'

describe('releaseFor', () => {
  it('names the release after the app, version and Vercel commit', () => {
    expect(releaseFor({ [VERCEL_COMMIT_VARIABLE]: 'ABCDEF1234567' })).toBe(
      `${WEB_APP_NAME}@${WEB_APP_VERSION}+abcdef1234567`,
    )
  })

  it('omits a missing or malformed commit', () => {
    expect(releaseFor({})).toBe(`${WEB_APP_NAME}@${WEB_APP_VERSION}`)
    expect(releaseFor({ [VERCEL_COMMIT_VARIABLE]: 'not-a-sha' })).toBe(
      `${WEB_APP_NAME}@${WEB_APP_VERSION}`,
    )
    expect(releaseFor({ [VERCEL_COMMIT_VARIABLE]: '   ' })).toBe(`${WEB_APP_NAME}@${WEB_APP_VERSION}`)
  })
})

describe('loadWebServerEnv', () => {
  it('loads the server and public schemas plus the platform variables', () => {
    const env = loadWebServerEnv(
      testEnvSource({
        [VERCEL_CRON_SECRET_VARIABLE]: ' vercel-secret ',
        [LOG_LEVEL_VARIABLE]: 'DEBUG',
        [VERCEL_COMMIT_VARIABLE]: 'abc1234',
      }),
    )
    expect(env.server.INTERNAL_CRON_SECRET).toBe(TEST_CRON_SECRET)
    expect(env.server.HUMAN_VERIFICATION_PROVIDER).toBe('mock')
    expect(env.public.SUPABASE_URL).toBe(TEST_SUPABASE_URL)
    expect(env.public.SUPABASE_ANON_KEY).toBe(TEST_ANON_KEY)
    expect(env.vercelCronSecret).toBe('vercel-secret')
    expect(env.logLevel).toBe('debug')
    expect(env.release).toBe(`${WEB_APP_NAME}@${WEB_APP_VERSION}+abc1234`)
  })

  it('defaults the platform variables', () => {
    const env = loadWebServerEnv(testEnvSource({ [VERCEL_CRON_SECRET_VARIABLE]: '' }))
    expect(env.vercelCronSecret).toBeUndefined()
    expect(env.logLevel).toBe('info')
  })

  it('reports server and public issues together', () => {
    const source = testEnvSource({
      INTERNAL_CRON_SECRET: 'short',
      NEXT_PUBLIC_MAP_STYLE_URL: '',
    })
    let caught: unknown
    try {
      loadWebServerEnv(source)
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(EnvError)
    const variables = (caught as EnvError).issues.map((issue) => issue.variable)
    expect(variables).toContain('INTERNAL_CRON_SECRET')
    expect(variables).toContain('NEXT_PUBLIC_MAP_STYLE_URL')
  })

  it('refuses the mock verifier in production', () => {
    expect(() =>
      loadWebServerEnv(
        testEnvSource({
          APP_ENV: 'production',
          NEXT_PUBLIC_APP_ENV: 'production',
          NEXT_PUBLIC_API_BASE_URL: 'https://earth.social',
          NEXT_PUBLIC_LIVEKIT_URL: 'wss://rtc.earth.social',
          NEXT_PUBLIC_WEB_ORIGIN: 'https://earth.social',
        }),
      ),
    ).toThrow(EnvError)
  })
})
