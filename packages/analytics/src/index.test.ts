import { describe, expect, it } from 'vitest'

import * as analytics from './index'

describe('@earth/analytics', () => {
  it('exposes its package name and the public surface', () => {
    expect(analytics.PACKAGE_NAME).toBe('@earth/analytics')
    expect(typeof analytics.createAnalytics).toBe('function')
    expect(typeof analytics.createFirstPartyProvider).toBe('function')
    expect(typeof analytics.createPostHogWebProvider).toBe('function')
    expect(typeof analytics.createPostHogNodeProvider).toBe('function')
    expect(typeof analytics.createPostHogReactNativeProvider).toBe('function')
    expect(typeof analytics.createNoopProvider).toBe('function')
    expect(typeof analytics.createConsoleProvider).toBe('function')
    expect(typeof analytics.createSinkProvider).toBe('function')
    expect(analytics.EVENT_NAMES.length).toBeGreaterThan(0)
    expect(analytics.FIRST_PARTY_METRIC_KEYS.length).toBeGreaterThan(0)
    expect(analytics.ANALYTICS_INGEST_PATH).toBe('/api/analytics/ingest')
  })
})
