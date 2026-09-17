/**
 * The two instrumentation entry points (docs/DEPLOYMENT.md §8): a browser Sentry client that only
 * exists when `NEXT_PUBLIC_SENTRY_DSN` is set, a server one gated on `SENTRY_DSN` and the Node
 * runtime, and one release name shared with the server tier.
 */
import { describe, expect, it, vi } from 'vitest'

import {
  APP_ENV_VARIABLE,
  COMMIT_VARIABLE,
  NEXT_RUNTIME_VARIABLE,
  SENTRY_DSN_VARIABLE,
  SERVER_RELEASE_APP,
  onRequestError,
  register,
  serverRelease,
  serverSentryOptions,
} from './instrumentation'
import {
  BROWSER_APP_ENV_VARIABLE,
  BROWSER_COMMIT_VARIABLE,
  BROWSER_DSN_VARIABLE,
  BROWSER_RELEASE_APP,
  type BrowserSentryLike,
  type BrowserSentryOptions,
  browserRelease,
  browserSentryOptions,
  initBrowserMonitoring,
} from './instrumentation-client'
import { WEB_APP_NAME, WEB_APP_VERSION, releaseFor } from './lib/server/env'

const DSN = 'https://public@o1.ingest.sentry.io/42'
const COMMIT = '9F2C1A4B7D3E5061728394A5B6C7D8E9F0A1B2C3'

function recorder(): { sentry: BrowserSentryLike; inits: BrowserSentryOptions[] } {
  const inits: BrowserSentryOptions[] = []
  return {
    inits,
    sentry: {
      init: (options) => inits.push(options),
    },
  }
}

describe('browser Sentry client', () => {
  it('is not created without NEXT_PUBLIC_SENTRY_DSN', () => {
    const { sentry, inits } = recorder()
    expect(browserSentryOptions({})).toBeNull()
    expect(browserSentryOptions({ [BROWSER_DSN_VARIABLE]: '   ' })).toBeNull()
    expect(initBrowserMonitoring(sentry, {})).toBeNull()
    expect(inits).toEqual([])
  })

  it('initialises with the DSN, the app environment, the release and no PII', () => {
    const { sentry, inits } = recorder()
    const applied = initBrowserMonitoring(sentry, {
      [BROWSER_DSN_VARIABLE]: DSN,
      [BROWSER_APP_ENV_VARIABLE]: 'production',
      [BROWSER_COMMIT_VARIABLE]: COMMIT,
    })
    expect(applied).toEqual({
      dsn: DSN,
      environment: 'production',
      release: `earth-web@${WEB_APP_VERSION}+${COMMIT.toLowerCase()}`,
      sendDefaultPii: false,
    })
    expect(inits).toEqual([applied])
  })

  it('defaults the environment to development and drops a commit that is not a sha', () => {
    expect(browserSentryOptions({ [BROWSER_DSN_VARIABLE]: DSN })).toEqual({
      dsn: DSN,
      environment: 'development',
      release: `earth-web@${WEB_APP_VERSION}`,
      sendDefaultPii: false,
    })
    expect(browserRelease('not a sha')).toBe(`earth-web@${WEB_APP_VERSION}`)
    expect(browserRelease(undefined)).toBe(`earth-web@${WEB_APP_VERSION}`)
  })

  it('never lets a failing SDK break the page', () => {
    const throwing: BrowserSentryLike = {
      init: () => {
        throw new Error('sentry is down')
      },
    }
    expect(initBrowserMonitoring(throwing, { [BROWSER_DSN_VARIABLE]: DSN })).toBeNull()
  })
})

describe('server instrumentation', () => {
  it('is not created without SENTRY_DSN', () => {
    expect(serverSentryOptions({})).toBeNull()
    expect(serverSentryOptions({ [SENTRY_DSN_VARIABLE]: '' })).toBeNull()
  })

  it('stays out of the Edge runtime', () => {
    expect(serverSentryOptions({ [SENTRY_DSN_VARIABLE]: DSN, [NEXT_RUNTIME_VARIABLE]: 'edge' })) //
      .toBeNull()
    expect(
      serverSentryOptions({ [SENTRY_DSN_VARIABLE]: DSN, [NEXT_RUNTIME_VARIABLE]: 'nodejs' }),
    ).not.toBeNull()
  })

  it('uses APP_ENV, falling back to the public copy, and the commit release', () => {
    expect(
      serverSentryOptions({
        [SENTRY_DSN_VARIABLE]: DSN,
        [APP_ENV_VARIABLE]: 'preview',
        [COMMIT_VARIABLE]: COMMIT,
      }),
    ).toEqual({
      dsn: DSN,
      environment: 'preview',
      release: `earth-web@${WEB_APP_VERSION}+${COMMIT.toLowerCase()}`,
      sendDefaultPii: false,
    })
    expect(
      serverSentryOptions({ [SENTRY_DSN_VARIABLE]: DSN, NEXT_PUBLIC_APP_ENV: 'production' })
        ?.environment,
    ).toBe('production')
  })

  it('registers and reports without throwing when nothing is configured', async () => {
    vi.stubEnv(SENTRY_DSN_VARIABLE, '')
    try {
      await expect(register()).resolves.toBeUndefined()
      await expect(
        onRequestError(new Error('boom'), { path: '/', method: 'GET', headers: {} }, {
          routerKind: 'App Router',
          routePath: '/',
          routeType: 'render',
        } as Parameters<typeof onRequestError>[2]),
      ).resolves.toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('release parity with the server tier', () => {
  it('names the same app and builds the same release string', () => {
    expect(BROWSER_RELEASE_APP).toBe(WEB_APP_NAME)
    expect(SERVER_RELEASE_APP).toBe(WEB_APP_NAME)
    expect(browserRelease(COMMIT)).toBe(releaseFor({ VERCEL_GIT_COMMIT_SHA: COMMIT }))
    expect(serverRelease(COMMIT)).toBe(releaseFor({ VERCEL_GIT_COMMIT_SHA: COMMIT }))
    expect(browserRelease(undefined)).toBe(releaseFor({}))
  })
})
