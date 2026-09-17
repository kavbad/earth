import {
  CONSOLE_PROVIDER_NAME,
  FIRST_PARTY_PROVIDER_NAME,
  NOOP_PROVIDER_NAME,
  POSTHOG_REACT_NATIVE_PROVIDER_NAME,
} from '@earth/analytics'
import { describe, expect, it } from 'vitest'

import { analyticsPlatformFor, selectAnalyticsProviders } from './setup'

const base = {
  apiBaseUrl: 'http://localhost:3000',
  fetch: () => Promise.reject(new Error('unused')),
  getAccessToken: () => Promise.resolve(null),
}

describe('selectAnalyticsProviders', () => {
  it('uses PostHog when an instance is given, plus the first-party sink', () => {
    const posthog = { capture: () => undefined, identify: () => undefined, reset: () => undefined }
    const names = selectAnalyticsProviders({ ...base, posthog, isDevelopment: false }).map(
      (p) => p.name,
    )
    expect(names).toEqual([POSTHOG_REACT_NATIVE_PROVIDER_NAME, FIRST_PARTY_PROVIDER_NAME])
  })

  it('logs to the console in development and drops the vendor leg in production', () => {
    expect(
      selectAnalyticsProviders({ ...base, posthog: null, isDevelopment: true }).map((p) => p.name),
    ).toEqual([CONSOLE_PROVIDER_NAME, FIRST_PARTY_PROVIDER_NAME])
    expect(
      selectAnalyticsProviders({ ...base, posthog: null, isDevelopment: false }).map((p) => p.name),
    ).toEqual([NOOP_PROVIDER_NAME, FIRST_PARTY_PROVIDER_NAME])
  })
})

describe('analyticsPlatformFor', () => {
  it('maps the OS to the two mobile platforms', () => {
    expect(analyticsPlatformFor('ios')).toBe('ios')
    expect(analyticsPlatformFor('android')).toBe('android')
    expect(analyticsPlatformFor('web')).toBe('android')
  })
})
