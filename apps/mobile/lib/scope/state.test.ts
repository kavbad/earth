import { FEATURE_FLAG_DEFAULTS } from '@earth/config'
import { describe, expect, it } from 'vitest'

import { createMemoryStorage } from '../storage'
import {
  availabilityByScope,
  defaultScopeFor,
  initialScopes,
  readStoredScopes,
  rememberScope,
  scopeAvailability,
  scopeReducer,
  scopeStorageKey,
} from './state'

const flags = FEATURE_FLAG_DEFAULTS

describe('scope availability', () => {
  it('opens every radius to a Human and only World to a Visitor', () => {
    expect(availabilityByScope({ roleKind: 'human', flags })).toEqual({
      friends: 'available',
      neighborhood: 'available',
      city: 'available',
      world: 'available',
    })
    expect(availabilityByScope({ roleKind: 'visitor', flags })).toEqual({
      friends: 'claim',
      neighborhood: 'claim',
      city: 'claim',
      world: 'available',
    })
  })

  it('disables a radius its flag turned off', () => {
    const off = { ...flags, CITY_ENABLED: false, PUBLIC_WORLD_ENABLED: false }
    expect(scopeAvailability('city', { roleKind: 'human', flags: off })).toBe('disabled')
    expect(scopeAvailability('world', { roleKind: 'visitor', flags: off })).toBe('disabled')
    expect(scopeAvailability('world', { roleKind: 'human', flags: off })).toBe('available')
  })
})

describe('initialScopes', () => {
  it('defaults to Friends for Humans and World for Visitors', () => {
    expect(defaultScopeFor('human')).toBe('friends')
    expect(defaultScopeFor('guest')).toBe('world')
    expect(initialScopes({ roleKind: 'human', stored: {}, flags })).toEqual({
      home: 'friends',
      live: 'friends',
      earth: 'friends',
    })
  })

  it('honours a remembered radius only while it is available', () => {
    const stored = { home: 'city', live: 'nonsense', earth: 'friends' }
    expect(initialScopes({ roleKind: 'human', stored, flags })).toEqual({
      home: 'city',
      live: 'friends',
      earth: 'friends',
    })
    expect(initialScopes({ roleKind: 'visitor', stored, flags })).toEqual({
      home: 'world',
      live: 'world',
      earth: 'world',
    })
  })

  it('falls back to World when the default itself is off', () => {
    const off = { ...flags, WORLD_ENABLED: true }
    expect(initialScopes({ roleKind: 'human', stored: { home: 'city' }, flags: off }).home).toBe(
      'city',
    )
  })
})

describe('scopeReducer and storage', () => {
  it('sets one surface and resets all', () => {
    const start = { home: 'world', live: 'world', earth: 'world' } as const
    const next = scopeReducer(start, { type: 'set', surface: 'home', scope: 'city' })
    expect(next).toEqual({ home: 'city', live: 'world', earth: 'world' })
    expect(scopeReducer(next, { type: 'set', surface: 'home', scope: 'city' })).toBe(next)
    expect(scopeReducer(next, { type: 'reset', scopes: start })).toEqual(start)
  })

  it('remembers per device for Visitors and per Human otherwise', async () => {
    const store = createMemoryStorage()
    await rememberScope(store, 'home', null, 'world')
    await rememberScope(store, 'home', 'h1', 'city')
    expect(scopeStorageKey('home', null)).toBe('earth.scope.home')
    expect(scopeStorageKey('home', 'h1')).toBe('earth.scope.h1.home')
    expect(await readStoredScopes(store, null)).toEqual({ home: 'world', live: null, earth: null })
    expect((await readStoredScopes(store, 'h1')).home).toBe('city')
  })
})
