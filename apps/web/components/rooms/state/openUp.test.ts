import { FEATURE_FLAG_DEFAULTS, type FeatureFlags } from '@earth/config'
import { describe, expect, it } from 'vitest'

import {
  defaultJoinPolicyFor,
  isVisibilityEnabled,
  openUpJoinPolicyOptions,
  openUpVisibilityOptions,
} from './openUp'

const flags = (overrides: Partial<FeatureFlags> = {}): FeatureFlags => ({
  ...FEATURE_FLAG_DEFAULTS,
  ...overrides,
})

describe('openUpVisibilityOptions (SCREEN 15)', () => {
  it('offers Group, Friends, Neighborhood, City, World to a group room', () => {
    const options = openUpVisibilityOptions('group', flags(), 'group')
    expect(options.map((o) => o.visibility)).toEqual([
      'group',
      'friends',
      'neighborhood',
      'city',
      'world',
    ])
    expect(options.map((o) => o.label)).toEqual([
      'Group',
      'Friends',
      'Neighborhood',
      'City',
      'World',
    ])
    expect(options[0]?.description).toBe('Only members of this group can see this room.')
  })

  it('offers Just us instead of Group outside a group', () => {
    expect(openUpVisibilityOptions('direct', flags(), 'invited')[0]).toMatchObject({
      visibility: 'invited',
      label: 'Just us',
    })
    expect(
      openUpVisibilityOptions('standalone', flags(), 'friends').map((o) => o.visibility),
    ).toEqual(['invited', 'friends', 'neighborhood', 'city', 'world'])
  })

  it('drops visibilities the flags turn off, keeping the current one', () => {
    const noPublic = flags({ PUBLIC_LIVE_ENABLED: false })
    expect(openUpVisibilityOptions('group', noPublic, 'group').map((o) => o.visibility)).toEqual([
      'group',
      'friends',
    ])
    const noFriends = flags({ FRIENDS_LIVE_EXPANSION_ENABLED: false })
    expect(openUpVisibilityOptions('group', noFriends, 'group').map((o) => o.visibility)).toEqual([
      'group',
      'neighborhood',
      'city',
      'world',
    ])
    // A room already at Friends keeps showing where it is even after the flag flips.
    expect(openUpVisibilityOptions('group', noFriends, 'friends').map((o) => o.visibility)).toEqual(
      ['group', 'friends', 'neighborhood', 'city', 'world'],
    )
    const noWorld = flags({ WORLD_LIVE_EXPANSION_ENABLED: false })
    expect(openUpVisibilityOptions('group', noWorld, 'group').map((o) => o.visibility)).toEqual([
      'group',
      'friends',
      'neighborhood',
      'city',
    ])
  })

  it('reads every flag that gates a visibility', () => {
    expect(isVisibilityEnabled('neighborhood', flags({ NEIGHBORHOOD_ENABLED: false }))).toBe(false)
    expect(isVisibilityEnabled('city', flags({ CITY_ENABLED: false }))).toBe(false)
    expect(isVisibilityEnabled('world', flags({ WORLD_ENABLED: false }))).toBe(false)
    expect(isVisibilityEnabled('extended', flags({ FRIENDS_LIVE_EXPANSION_ENABLED: false }))).toBe(
      false,
    )
    expect(isVisibilityEnabled('invited', flags({ PUBLIC_LIVE_ENABLED: false }))).toBe(true)
  })
})

describe('openUpJoinPolicyOptions ("Who can join")', () => {
  it('offers only sensible pairs, in the sheet order', () => {
    expect(openUpJoinPolicyOptions('invited', 'direct').map((o) => o.joinPolicy)).toEqual([
      'invited_only',
      'request',
    ])
    expect(openUpJoinPolicyOptions('group', 'group').map((o) => o.joinPolicy)).toEqual([
      'invited_only',
      'group',
      'request',
    ])
    expect(openUpJoinPolicyOptions('friends', 'standalone').map((o) => o.joinPolicy)).toEqual([
      'invited_only',
      'friends',
      'request',
    ])
    expect(openUpJoinPolicyOptions('world', 'group').map((o) => o.joinPolicy)).toEqual([
      'invited_only',
      'group',
      'friends',
      'request',
      'anyone',
    ])
  })

  it('carries a label and a sentence for every option', () => {
    for (const option of openUpJoinPolicyOptions('world', 'group')) {
      expect(option.label.length).toBeGreaterThan(0)
      expect(option.description.endsWith('.')).toBe(true)
    }
  })
})

describe('defaultJoinPolicyFor', () => {
  it('keeps the current policy when the new visibility still offers it', () => {
    expect(defaultJoinPolicyFor('friends', 'group', 'group')).toBe('group')
  })

  it("falls back to the domain default when the current policy isn't offered", () => {
    expect(defaultJoinPolicyFor('invited', 'group', 'group')).toBe('invited_only')
    expect(defaultJoinPolicyFor('world', 'standalone', 'group')).toBe('request')
  })
})
