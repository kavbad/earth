import { describe, expect, it } from 'vitest'

import {
  AUDIENCE_ORDER,
  allowedJoinPoliciesFor,
  audienceRank,
  compareAudience,
  compareVisibility,
  consentSatisfies,
  defaultJoinPolicyFor,
  defaultRoomVisibilityFor,
  discoveryScopeForVisibility,
  isAudienceWithin,
  isJoinPolicyAllowedFor,
  isVisibilityAtLeast,
  isWidening,
  JOIN_POLICY_REACH,
  joinPolicyWithinVisibility,
  narrowerOf,
  needsConsent,
  openUpOptionsFor,
  ROOM_VISIBILITY_ORDER,
  scopeToAudience,
  visibilityRank,
  widerOf,
  widerVisibilityOf,
} from './audience'
import {
  AUDIENCE,
  ROOM_CONTEXT_TYPE,
  ROOM_JOIN_POLICY,
  ROOM_VISIBILITY,
  type Audience,
  type RoomVisibility,
} from './enums'

describe('audience ordering', () => {
  it('orders friends < neighborhood < city < world', () => {
    expect(AUDIENCE_ORDER).toEqual(['friends', 'neighborhood', 'city', 'world'])
    expect(audienceRank('friends')).toBe(0)
    expect(audienceRank('world')).toBe(3)
    expect(compareAudience('friends', 'world')).toBeLessThan(0)
    expect(compareAudience('world', 'friends')).toBeGreaterThan(0)
    expect(compareAudience('city', 'city')).toBe(0)
  })

  it('isAudienceWithin matrix: candidate may not exceed limit', () => {
    const expected: Record<Audience, Record<Audience, boolean>> = {
      friends: { friends: true, neighborhood: true, city: true, world: true },
      neighborhood: { friends: false, neighborhood: true, city: true, world: true },
      city: { friends: false, neighborhood: false, city: true, world: true },
      world: { friends: false, neighborhood: false, city: false, world: true },
    }
    for (const candidate of AUDIENCE) {
      for (const limit of AUDIENCE) {
        expect(isAudienceWithin(candidate, limit), `${candidate} within ${limit}`).toBe(
          expected[candidate][limit],
        )
      }
    }
  })

  it('widerOf / narrowerOf / isWidening', () => {
    expect(widerOf('friends', 'city')).toBe('city')
    expect(widerOf('world', 'city')).toBe('world')
    expect(narrowerOf('friends', 'city')).toBe('friends')
    expect(narrowerOf('neighborhood', 'neighborhood')).toBe('neighborhood')
    expect(isWidening('friends', 'world')).toBe(true)
    expect(isWidening('world', 'friends')).toBe(false)
    expect(isWidening('city', 'city')).toBe(false)
  })

  it('scope maps 1:1 onto audience', () => {
    for (const scope of AUDIENCE) expect(scopeToAudience(scope)).toBe(scope)
  })
})

describe('room visibility ordering', () => {
  it('orders invited < group < friends < extended < neighborhood < city < world', () => {
    expect(ROOM_VISIBILITY_ORDER).toEqual([
      'invited',
      'group',
      'friends',
      'extended',
      'neighborhood',
      'city',
      'world',
    ])
    ROOM_VISIBILITY.forEach((visibility, index) => expect(visibilityRank(visibility)).toBe(index))
    expect(compareVisibility('invited', 'world')).toBeLessThan(0)
    expect(compareVisibility('extended', 'friends')).toBeGreaterThan(0)
    expect(widerVisibilityOf('group', 'city')).toBe('city')
  })

  it('isVisibilityAtLeast is reflexive and monotone', () => {
    for (const a of ROOM_VISIBILITY) {
      for (const b of ROOM_VISIBILITY) {
        expect(isVisibilityAtLeast(a, b)).toBe(visibilityRank(a) >= visibilityRank(b))
      }
    }
  })

  it('consent: level must be >= visibility; viewers never need consent', () => {
    expect(consentSatisfies('friends', 'friends')).toBe(true)
    expect(consentSatisfies('world', 'friends')).toBe(true)
    expect(consentSatisfies('group', 'friends')).toBe(false)
    expect(needsConsent('watching', 'invited', 'world')).toBe(false)
    expect(needsConsent('audio', 'invited', 'world')).toBe(true)
    expect(needsConsent('camera', 'world', 'city')).toBe(false)
    expect(needsConsent('camera', 'city', 'world')).toBe(true)
  })

  it('discovery scope: invited/group rooms are not discoverable; extended surfaces in Friends', () => {
    expect(discoveryScopeForVisibility('invited')).toBeNull()
    expect(discoveryScopeForVisibility('group')).toBeNull()
    expect(discoveryScopeForVisibility('friends')).toBe('friends')
    expect(discoveryScopeForVisibility('extended')).toBe('friends')
    expect(discoveryScopeForVisibility('neighborhood')).toBe('neighborhood')
    expect(discoveryScopeForVisibility('city')).toBe('city')
    expect(discoveryScopeForVisibility('world')).toBe('world')
  })

  it('open up options start with the context floor and go outward', () => {
    expect(openUpOptionsFor('group')).toEqual(['group', 'friends', 'neighborhood', 'city', 'world'])
    expect(openUpOptionsFor('direct')).toEqual([
      'invited',
      'friends',
      'neighborhood',
      'city',
      'world',
    ])
  })
})

describe('room defaults (ARCHITECTURE §10)', () => {
  it('group → group/group, direct → invited/invited_only, standalone → friends/friends', () => {
    expect(defaultRoomVisibilityFor('group')).toBe('group')
    expect(defaultJoinPolicyFor('group')).toBe('group')
    expect(defaultRoomVisibilityFor('direct')).toBe('invited')
    expect(defaultJoinPolicyFor('direct')).toBe('invited_only')
    expect(defaultRoomVisibilityFor('standalone')).toBe('friends')
    expect(defaultJoinPolicyFor('standalone')).toBe('friends')
  })

  it('reserved contexts default to the narrowest pair', () => {
    expect(defaultRoomVisibilityFor('event')).toBe('invited')
    expect(defaultJoinPolicyFor('event')).toBe('invited_only')
    expect(defaultRoomVisibilityFor('place')).toBe('invited')
    expect(defaultJoinPolicyFor('place')).toBe('invited_only')
  })

  it('every context has a default pair that the UI would offer', () => {
    for (const context of ROOM_CONTEXT_TYPE) {
      const visibility = defaultRoomVisibilityFor(context)
      expect(allowedJoinPoliciesFor(visibility)).toContain(defaultJoinPolicyFor(context))
    }
  })
})

describe('allowedJoinPoliciesFor', () => {
  it('returns the sensible pairs, default first', () => {
    expect(allowedJoinPoliciesFor('invited')).toEqual(['invited_only', 'request'])
    expect(allowedJoinPoliciesFor('group')).toEqual(['group', 'invited_only', 'request'])
    expect(allowedJoinPoliciesFor('friends')).toEqual([
      'friends',
      'group',
      'request',
      'invited_only',
    ])
    expect(allowedJoinPoliciesFor('extended')).toEqual([
      'friends_of_friends',
      'friends',
      'group',
      'request',
      'anyone_with_link',
      'anyone',
      'invited_only',
    ])
    for (const visibility of ['neighborhood', 'city', 'world'] as const) {
      expect(allowedJoinPoliciesFor(visibility)).toEqual([
        'request',
        'anyone',
        'anyone_with_link',
        'friends_of_friends',
        'friends',
        'group',
        'invited_only',
      ])
    }
  })

  it('never offers a policy that reaches further than the visibility', () => {
    expect(isJoinPolicyAllowedFor('invited', 'anyone')).toBe(false)
    expect(isJoinPolicyAllowedFor('group', 'friends')).toBe(false)
    expect(isJoinPolicyAllowedFor('friends', 'anyone_with_link')).toBe(false)
    // friends of friends cannot see a Friends room, so the policy would let nobody extra in.
    expect(isJoinPolicyAllowedFor('friends', 'friends_of_friends')).toBe(false)
    expect(isJoinPolicyAllowedFor('world', 'anyone')).toBe(true)
    for (const visibility of ROOM_VISIBILITY) {
      for (const policy of allowedJoinPoliciesFor(visibility)) {
        expect(joinPolicyWithinVisibility(policy, visibility), `${policy} @ ${visibility}`).toBe(
          true,
        )
        const reach: RoomVisibility | null = JOIN_POLICY_REACH[policy]
        if (reach !== null)
          expect(visibilityRank(reach)).toBeLessThanOrEqual(visibilityRank(visibility))
      }
    }
  })

  it('offers every policy that fits: friends_of_friends pairs with extended, group with any group-room visibility', () => {
    expect(isJoinPolicyAllowedFor('extended', 'friends_of_friends')).toBe(true)
    for (const visibility of [
      'group',
      'friends',
      'extended',
      'neighborhood',
      'city',
      'world',
    ] as const) {
      expect(isJoinPolicyAllowedFor(visibility, 'group'), visibility).toBe(true)
      expect(isJoinPolicyAllowedFor(visibility, 'group', 'group'), visibility).toBe(true)
    }
    expect(isJoinPolicyAllowedFor('invited', 'group')).toBe(false)
  })

  it('drops the group policy for rooms without a group when the context is known', () => {
    for (const context of ['direct', 'standalone', 'event', 'place'] as const) {
      for (const visibility of ROOM_VISIBILITY) {
        expect(allowedJoinPoliciesFor(visibility, context)).not.toContain('group')
        expect(isJoinPolicyAllowedFor(visibility, 'group', context)).toBe(false)
      }
    }
    expect(allowedJoinPoliciesFor('friends', 'standalone')).toEqual([
      'friends',
      'request',
      'invited_only',
    ])
    expect(allowedJoinPoliciesFor('friends', 'group')).toEqual(allowedJoinPoliciesFor('friends'))
  })

  it('only returns known policies without duplicates', () => {
    for (const visibility of ROOM_VISIBILITY) {
      const policies = allowedJoinPoliciesFor(visibility)
      expect(new Set(policies).size).toBe(policies.length)
      for (const policy of policies) expect(ROOM_JOIN_POLICY).toContain(policy)
    }
  })
})
