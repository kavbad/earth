import { describe, expect, it } from 'vitest'

import {
  ANALYTICS_INGEST_MAX_EVENTS,
  ANALYTICS_MAX_ARRAY_LENGTH,
  ANALYTICS_MAX_PROPERTIES_PER_EVENT,
  ANALYTICS_MAX_PROPERTY_KEY_LENGTH,
  ANALYTICS_MAX_STRING_LENGTH,
  AnalyticsEnvelopeSchema,
  AnalyticsIngestBatchSchema,
  AnalyticsPropertiesSchema,
  ingestUrl,
  invalidReservedProperties,
  wireProperties,
} from './ingest'

const HUMAN = '11111111-1111-4111-8111-111111111111'
const GUEST = '22222222-2222-4222-8222-222222222222'
const VISITOR = '33333333-3333-4333-8333-333333333333'
/** A valid RFC 4122 v1 uuid: fine for table ids, not a v4 anonymous visitor id. */
const V1_UUID = '11111111-1111-1111-8111-111111111111'
const BASE = { v: 1, sentAt: '2026-09-03T10:00:00.000Z' }

const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.success ? [] : (result.error?.issues.map((i) => i.path.join('.')) ?? [])

describe('ingest wire format', () => {
  it('builds the ingest url without double slashes', () => {
    expect(ingestUrl('https://earth.social')).toBe('https://earth.social/api/analytics/ingest')
    expect(ingestUrl('https://earth.social///')).toBe('https://earth.social/api/analytics/ingest')
  })

  it('accepts a well-formed batch', () => {
    const batch = {
      ...BASE,
      events: [
        { name: 'room_joined', properties: { roomId: 'r', mediaState: 'camera', n: 1, ok: true } },
        { name: 'search_performed', properties: { tags: ['a', 'b'], nothing: null } },
      ],
    }
    expect(AnalyticsIngestBatchSchema.parse(batch)).toEqual(batch)
  })

  it('accepts every §96 reserved key when well-formed', () => {
    const properties = {
      humanId: HUMAN,
      guestSessionId: GUEST,
      anonymousVisitorId: VISITOR,
      appVersion: '1.2.3',
      platform: 'ios',
      timestamp: '2026-09-03T12:00:00+02:00',
      scope: 'city',
    }
    expect(AnalyticsPropertiesSchema.parse(properties)).toEqual(properties)
    expect(invalidReservedProperties(properties)).toEqual([])
    for (const platform of ['ios', 'android', 'web', 'server']) {
      expect(AnalyticsPropertiesSchema.safeParse({ platform }).success, platform).toBe(true)
    }
  })

  it('rejects unknown events, GPS keys, nested objects, empty and oversized batches', () => {
    expect(AnalyticsEnvelopeSchema.safeParse({ name: 'page_view', properties: {} }).success).toBe(
      false,
    )
    expect(
      AnalyticsEnvelopeSchema.safeParse({ name: 'room_joined', properties: { lat: 1 } }).success,
    ).toBe(false)
    expect(
      AnalyticsEnvelopeSchema.safeParse({ name: 'room_joined', properties: { place: { a: 1 } } })
        .success,
    ).toBe(false)
    expect(AnalyticsIngestBatchSchema.safeParse({ ...BASE, events: [] }).success).toBe(false)
    const tooMany = Array.from({ length: ANALYTICS_INGEST_MAX_EVENTS + 1 }, () => ({
      name: 'feed_opened',
      properties: {},
    }))
    expect(AnalyticsIngestBatchSchema.safeParse({ ...BASE, events: tooMany }).success).toBe(false)
    expect(
      AnalyticsIngestBatchSchema.safeParse({ ...BASE, v: 2, events: tooMany.slice(0, 1) }).success,
    ).toBe(false)
    expect(
      AnalyticsIngestBatchSchema.safeParse({
        ...BASE,
        sentAt: 'yesterday',
        events: tooMany.slice(0, 1),
      }).success,
    ).toBe(false)
  })

  it('rejects GPS by value as well as by key, at any position', () => {
    expect(AnalyticsPropertiesSchema.safeParse({ area: '37.7749,-122.4194' }).success).toBe(false)
    expect(
      AnalyticsPropertiesSchema.safeParse({ tags: ['ok', 'geo:37.7749,-122.4194'] }).success,
    ).toBe(false)
    expect(AnalyticsPropertiesSchema.safeParse({ userLatLng: 'x' }).success).toBe(false)
    expect(AnalyticsPropertiesSchema.safeParse({ lat1: 1 }).success).toBe(false)
  })

  it('accepts only plain identifier keys', () => {
    for (const key of ['a', 'A_1', 'roomId', 'x'.repeat(ANALYTICS_MAX_PROPERTY_KEY_LENGTH)]) {
      expect(AnalyticsPropertiesSchema.safeParse({ [key]: 1 }).success, key).toBe(true)
    }
    for (const key of [
      '',
      'a-b',
      'a.b',
      '1abc',
      '_private',
      'constructor.prototype',
      'with space',
      'x'.repeat(ANALYTICS_MAX_PROPERTY_KEY_LENGTH + 1),
    ]) {
      expect(AnalyticsPropertiesSchema.safeParse({ [key]: 1 }).success, JSON.stringify(key)).toBe(
        false,
      )
    }
  })

  it('never lets a JSON __proto__ key reach the parsed record', () => {
    const body: unknown = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}')
    const result = AnalyticsPropertiesSchema.safeParse(body)
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(Object.keys(result.data)).toEqual(['a'])
    expect(Object.getPrototypeOf(result.data)).toBe(Object.prototype)
    expect((result.data as { polluted?: unknown }).polluted).toBeUndefined()
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined()
  })

  it('caps property count, string length and array length', () => {
    const keys = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]))
    expect(
      AnalyticsPropertiesSchema.safeParse(keys(ANALYTICS_MAX_PROPERTIES_PER_EVENT)).success,
    ).toBe(true)
    expect(
      AnalyticsPropertiesSchema.safeParse(keys(ANALYTICS_MAX_PROPERTIES_PER_EVENT + 1)).success,
    ).toBe(false)

    expect(
      AnalyticsPropertiesSchema.safeParse({ s: 'x'.repeat(ANALYTICS_MAX_STRING_LENGTH) }).success,
    ).toBe(true)
    expect(
      AnalyticsPropertiesSchema.safeParse({ s: 'x'.repeat(ANALYTICS_MAX_STRING_LENGTH + 1) })
        .success,
    ).toBe(false)
    expect(
      AnalyticsPropertiesSchema.safeParse({ s: ['x'.repeat(ANALYTICS_MAX_STRING_LENGTH + 1)] })
        .success,
    ).toBe(false)

    const items = (n: number) => Array.from({ length: n }, (_, i) => i)
    expect(
      AnalyticsPropertiesSchema.safeParse({ a: items(ANALYTICS_MAX_ARRAY_LENGTH) }).success,
    ).toBe(true)
    expect(
      AnalyticsPropertiesSchema.safeParse({ a: items(ANALYTICS_MAX_ARRAY_LENGTH + 1) }).success,
    ).toBe(false)
    expect(AnalyticsPropertiesSchema.safeParse({ a: [null] }).success).toBe(false)
    expect(AnalyticsPropertiesSchema.safeParse({ a: [[1]] }).success).toBe(false)
  })

  it('rejects reserved §96 keys with the wrong shape and names them', () => {
    const cases: [string, unknown][] = [
      ['humanId', 'h1'],
      ['humanId', '00000000-0000-0000-0000-000000000001'],
      ['guestSessionId', 7],
      ['anonymousVisitorId', V1_UUID],
      ['anonymousVisitorId', 'visitor-1'],
      ['appVersion', ''],
      ['appVersion', 7],
      ['platform', 'tv'],
      ['platform', 'iOS'],
      ['timestamp', '2026-09-03'],
      ['timestamp', 1_700_000_000_000],
      ['timestamp', 'yesterday'],
    ]
    for (const [key, value] of cases) {
      const result = AnalyticsPropertiesSchema.safeParse({ [key]: value })
      expect(result.success, `${key}=${String(value)}`).toBe(false)
      expect(issuePaths(result), `${key}=${String(value)}`).toContain(key)
    }
    expect(AnalyticsPropertiesSchema.safeParse({ humanId: V1_UUID }).success).toBe(true)
  })

  it('reports invalid reserved keys in a stable order', () => {
    expect(
      invalidReservedProperties({ timestamp: 'x', platform: 'tv', humanId: 'h', scope: 'world' }),
    ).toEqual(['humanId', 'platform', 'timestamp'])
    expect(invalidReservedProperties({})).toEqual([])
  })

  it('wireProperties drops undefined values only', () => {
    expect(wireProperties({ a: 1, b: undefined, c: null, d: [1, 'x'] })).toEqual({
      a: 1,
      c: null,
      d: [1, 'x'],
    })
  })
})
