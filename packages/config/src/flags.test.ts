import { describe, expect, it } from 'vitest'

import {
  FEATURE_FLAG_DEFAULTS,
  FEATURE_FLAG_KEYS,
  FeatureFlag,
  FeatureFlagKeySchema,
  FlagRowSchema,
  FlagRowsSchema,
  isFeatureFlagKey,
  resolveFlags,
  resolveFlagsFrom,
} from './flags'

describe('FEATURE_FLAG_KEYS', () => {
  it('is exactly the spec §118 list, in order', () => {
    expect(FEATURE_FLAG_KEYS).toEqual([
      'GROUP_ANCHORED_CLAIM_REQUIRED',
      'PUBLIC_WORLD_ENABLED',
      'PUBLIC_LIVE_ENABLED',
      'NEIGHBORHOOD_ENABLED',
      'CITY_ENABLED',
      'WORLD_ENABLED',
      'GUEST_ROOMS_ENABLED',
      'FRIENDS_LIVE_EXPANSION_ENABLED',
      'WORLD_LIVE_EXPANSION_ENABLED',
      'LOCATION_SHARING_ENABLED',
      'MAFIA_ACTIVITY_ENABLED',
    ])
    expect(new Set(FEATURE_FLAG_KEYS).size).toBe(FEATURE_FLAG_KEYS.length)
  })

  it('exposes an object form and a zod enum over the same keys', () => {
    expect(Object.keys(FeatureFlag)).toEqual([...FEATURE_FLAG_KEYS])
    expect(FeatureFlag.MAFIA_ACTIVITY_ENABLED).toBe('MAFIA_ACTIVITY_ENABLED')
    expect(FeatureFlagKeySchema.options).toEqual([...FEATURE_FLAG_KEYS])
    expect(isFeatureFlagKey('WORLD_ENABLED')).toBe(true)
    expect(isFeatureFlagKey('world_enabled')).toBe(false)
    expect(isFeatureFlagKey('')).toBe(false)
  })
})

describe('FEATURE_FLAG_DEFAULTS', () => {
  it('matches ARCHITECTURE §12 launch defaults', () => {
    expect(FEATURE_FLAG_DEFAULTS).toEqual({
      GROUP_ANCHORED_CLAIM_REQUIRED: true,
      PUBLIC_WORLD_ENABLED: true,
      PUBLIC_LIVE_ENABLED: true,
      NEIGHBORHOOD_ENABLED: true,
      CITY_ENABLED: true,
      WORLD_ENABLED: true,
      GUEST_ROOMS_ENABLED: true,
      FRIENDS_LIVE_EXPANSION_ENABLED: true,
      WORLD_LIVE_EXPANSION_ENABLED: true,
      LOCATION_SHARING_ENABLED: true,
      MAFIA_ACTIVITY_ENABLED: false,
    })
  })

  it('covers every key and nothing else', () => {
    expect(Object.keys(FEATURE_FLAG_DEFAULTS).sort()).toEqual([...FEATURE_FLAG_KEYS].sort())
  })
})

describe('FlagRowSchema', () => {
  it('accepts a feature_flags row and ignores extra columns', () => {
    const parsed = FlagRowSchema.parse({
      key: 'WORLD_ENABLED',
      enabled: false,
      payload: null,
      updated_at: '2026-09-03T00:00:00Z',
    })
    expect(parsed).toEqual({ key: 'WORLD_ENABLED', enabled: false })
  })

  it('rejects malformed rows', () => {
    expect(FlagRowSchema.safeParse({ key: '', enabled: true }).success).toBe(false)
    expect(FlagRowSchema.safeParse({ key: 'WORLD_ENABLED', enabled: 'true' }).success).toBe(false)
    expect(FlagRowSchema.safeParse({ enabled: true }).success).toBe(false)
    expect(FlagRowsSchema.safeParse([{ key: 'X', enabled: true }, {}]).success).toBe(false)
  })
})

describe('resolveFlags', () => {
  it('returns the defaults for no rows', () => {
    const flags = resolveFlags([])
    expect(flags).toEqual(FEATURE_FLAG_DEFAULTS)
    expect(flags).not.toBe(FEATURE_FLAG_DEFAULTS)
  })

  it('overrides defaults with rows and keeps the rest', () => {
    const flags = resolveFlags([
      { key: FeatureFlag.MAFIA_ACTIVITY_ENABLED, enabled: true },
      { key: FeatureFlag.PUBLIC_WORLD_ENABLED, enabled: false },
    ])
    expect(flags.MAFIA_ACTIVITY_ENABLED).toBe(true)
    expect(flags.PUBLIC_WORLD_ENABLED).toBe(false)
    expect(flags.WORLD_ENABLED).toBe(true)
    expect(Object.keys(flags).sort()).toEqual([...FEATURE_FLAG_KEYS].sort())
  })

  it('ignores unknown keys and lets the last duplicate win', () => {
    const flags = resolveFlags([
      { key: 'SOME_FUTURE_FLAG', enabled: true },
      { key: FeatureFlag.CITY_ENABLED, enabled: false },
      { key: FeatureFlag.CITY_ENABLED, enabled: true },
    ])
    expect('SOME_FUTURE_FLAG' in flags).toBe(false)
    expect(flags.CITY_ENABLED).toBe(true)
  })

  it('does not mutate the defaults', () => {
    resolveFlags([{ key: FeatureFlag.WORLD_ENABLED, enabled: false }])
    expect(FEATURE_FLAG_DEFAULTS.WORLD_ENABLED).toBe(true)
  })

  it('resolveFlagsFrom validates untrusted input first', () => {
    expect(
      resolveFlagsFrom([{ key: 'GUEST_ROOMS_ENABLED', enabled: false }]).GUEST_ROOMS_ENABLED,
    ).toBe(false)
    expect(() => resolveFlagsFrom([{ key: 'GUEST_ROOMS_ENABLED', enabled: 'no' }])).toThrow()
    expect(() => resolveFlagsFrom(null)).toThrow()
  })
})
