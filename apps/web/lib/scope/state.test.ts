import { FEATURE_FLAG_DEFAULTS, FeatureFlag } from '@earth/config'
import { describe, expect, it } from 'vitest'

import { createMemoryStorage } from '../storage'
import {
  availabilityByScope,
  defaultScopeFor,
  initialScopes,
  rememberScope,
  scopeAvailability,
  scopeReducer,
  scopeStorageKey,
} from './state'

const flags = FEATURE_FLAG_DEFAULTS

describe('defaultScopeFor', () => {
  it('is Friends after membership and World for everyone else (spec §51)', () => {
    expect(defaultScopeFor('human')).toBe('friends')
    expect(defaultScopeFor('visitor')).toBe('world')
    expect(defaultScopeFor('guest')).toBe('world')
    expect(defaultScopeFor('claiming')).toBe('world')
  })
})

describe('scopeAvailability', () => {
  it('lets a Human open every radius under launch flags', () => {
    expect(availabilityByScope({ roleKind: 'human', flags })).toEqual({
      friends: 'available',
      neighborhood: 'available',
      city: 'available',
      world: 'available',
    })
  })

  it('shows the claim sheet to Visitors for Friends / Neighborhood / City and keeps World open', () => {
    expect(availabilityByScope({ roleKind: 'visitor', flags })).toEqual({
      friends: 'claim',
      neighborhood: 'claim',
      city: 'claim',
      world: 'available',
    })
  })

  it('disables a radius its flag turned off, for everyone', () => {
    const off = {
      ...flags,
      [FeatureFlag.NEIGHBORHOOD_ENABLED]: false,
      [FeatureFlag.CITY_ENABLED]: false,
    }
    expect(scopeAvailability('neighborhood', { roleKind: 'human', flags: off })).toBe('disabled')
    expect(scopeAvailability('city', { roleKind: 'visitor', flags: off })).toBe('disabled')
  })

  it('gates public World on PUBLIC_WORLD_ENABLED and member World on WORLD_ENABLED', () => {
    const noPublic = { ...flags, [FeatureFlag.PUBLIC_WORLD_ENABLED]: false }
    expect(scopeAvailability('world', { roleKind: 'visitor', flags: noPublic })).toBe('disabled')
    expect(scopeAvailability('world', { roleKind: 'human', flags: noPublic })).toBe('available')
    const noWorld = { ...flags, [FeatureFlag.WORLD_ENABLED]: false }
    expect(scopeAvailability('world', { roleKind: 'human', flags: noWorld })).toBe('disabled')
  })
})

describe('initialScopes', () => {
  it('defaults every surface for a fresh device', () => {
    expect(initialScopes({ roleKind: 'visitor', humanId: null, storage: null, flags })).toEqual({
      home: 'world',
      live: 'world',
      earth: 'world',
    })
    expect(initialScopes({ roleKind: 'human', humanId: 'h1', storage: null, flags })).toEqual({
      home: 'friends',
      live: 'friends',
      earth: 'friends',
    })
  })

  it('remembers the last scope per surface and per Human', () => {
    const storage = createMemoryStorage()
    rememberScope(storage, 'home', 'h1', 'city')
    rememberScope(storage, 'live', 'h1', 'world')
    rememberScope(storage, 'home', 'h2', 'neighborhood')
    expect(storage.values.get(scopeStorageKey('home', 'h1'))).toBe('city')
    expect(initialScopes({ roleKind: 'human', humanId: 'h1', storage, flags })).toEqual({
      home: 'city',
      live: 'world',
      earth: 'friends',
    })
    expect(initialScopes({ roleKind: 'human', humanId: 'h2', storage, flags }).home).toBe(
      'neighborhood',
    )
  })

  it('never restores a scope the person may not open now', () => {
    const storage = createMemoryStorage({ [scopeStorageKey('home', null)]: 'friends' })
    expect(initialScopes({ roleKind: 'visitor', humanId: null, storage, flags }).home).toBe('world')
    const off = { ...flags, [FeatureFlag.CITY_ENABLED]: false }
    const human = createMemoryStorage({ [scopeStorageKey('earth', 'h1')]: 'city' })
    expect(
      initialScopes({ roleKind: 'human', humanId: 'h1', storage: human, flags: off }).earth,
    ).toBe('friends')
  })

  it('ignores garbage in storage', () => {
    const storage = createMemoryStorage({ [scopeStorageKey('home', null)]: 'for-you' })
    expect(initialScopes({ roleKind: 'visitor', humanId: null, storage, flags }).home).toBe('world')
  })
})

describe('scopeReducer', () => {
  const base = { home: 'friends', live: 'friends', earth: 'friends' } as const

  it('changes one surface and keeps the others', () => {
    expect(scopeReducer(base, { type: 'set', surface: 'home', scope: 'world' })).toEqual({
      ...base,
      home: 'world',
    })
  })

  it('returns the same reference when nothing changes', () => {
    expect(scopeReducer(base, { type: 'set', surface: 'home', scope: 'friends' })).toBe(base)
  })

  it('resets wholesale', () => {
    const next = { home: 'city', live: 'world', earth: 'world' } as const
    expect(scopeReducer(base, { type: 'reset', scopes: next })).toBe(next)
  })
})
