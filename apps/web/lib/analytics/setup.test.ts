import { describe, expect, it } from 'vitest'

import { createWebAnalytics, selectAnalyticsProviders } from './setup'

const okFetch = async () => ({ ok: true, status: 200 })
const base = {
  apiBaseUrl: 'https://earth.test',
  fetch: okFetch,
  getAccessToken: async () => null,
}

describe('selectAnalyticsProviders', () => {
  it('uses PostHog plus the first-party sink when a key is configured', () => {
    const calls: string[] = []
    const posthog = {
      capture: (event: string) => calls.push(event),
      identify: () => undefined,
      reset: () => undefined,
    }
    const names = selectAnalyticsProviders({ ...base, posthog, isDevelopment: false }).map(
      (p) => p.name,
    )
    expect(names).toEqual(['posthog-web', 'first-party'])
  })

  it('falls back to the console in development and noop in production', () => {
    expect(
      selectAnalyticsProviders({ ...base, posthog: null, isDevelopment: true }).map((p) => p.name),
    ).toEqual(['console', 'first-party'])
    expect(
      selectAnalyticsProviders({ ...base, posthog: null, isDevelopment: false }).map((p) => p.name),
    ).toEqual(['noop', 'first-party'])
  })
})

describe('createWebAnalytics', () => {
  it('stamps web base properties and the identity onto every event', async () => {
    const captured: Array<{ event: string; properties: Record<string, unknown> }> = []
    const posthog = {
      capture: (event: string, properties?: Record<string, unknown>) => {
        captured.push({ event, properties: properties ?? {} })
      },
      identify: () => undefined,
      reset: () => undefined,
    }
    const analytics = createWebAnalytics({
      ...base,
      posthog,
      isDevelopment: false,
      appVersion: '0.1.0',
      identity: () => ({ anonymousVisitorId: '3f2b1c8e-6a2d-4c1e-9b7a-1f2e3d4c5b6a' }),
      now: () => 1_700_000_000_000,
    })
    analytics.track('scope_changed', { from: 'friends', to: 'world', surface: 'home' })
    await analytics.flush()
    expect(captured).toEqual([
      {
        event: 'scope_changed',
        properties: {
          appVersion: '0.1.0',
          platform: 'web',
          timestamp: new Date(1_700_000_000_000).toISOString(),
          anonymousVisitorId: '3f2b1c8e-6a2d-4c1e-9b7a-1f2e3d4c5b6a',
          from: 'friends',
          to: 'world',
          surface: 'home',
        },
      },
    ])
  })
})
