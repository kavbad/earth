import { fixtures } from '@earth/api/testing'
import { ProfileDtoSchema, RelationshipChangeDtoSchema } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { applyRelationshipChange, friendActionFor, profileActionsAvailable } from './relationship'

const profile = ProfileDtoSchema.parse(fixtures.profileDto())

describe('profile actions (SCREEN 22)', () => {
  it('names the friend affordance from the viewer side', () => {
    expect(friendActionFor(profile.relationship)).toBe('friends')
    expect(
      friendActionFor({ ...profile.relationship, isFriend: false, friendRequest: 'sent' }),
    ).toBe('requested')
    expect(
      friendActionFor({ ...profile.relationship, isFriend: false, friendRequest: 'received' }),
    ).toBe('accept')
    expect(
      friendActionFor({ ...profile.relationship, isFriend: false, friendRequest: 'none' }),
    ).toBe('add')
  })

  it('folds a relationship answer into the profile and its counts', () => {
    const removed = applyRelationshipChange(
      profile,
      RelationshipChangeDtoSchema.parse(
        fixtures.relationshipChange({ isFriend: false, friendRequest: 'none' }),
      ),
    )
    expect(removed.relationship.isFriend).toBe(false)
    expect(removed.counts.friends).toBe(profile.counts.friends - 1)
    const followed = applyRelationshipChange(
      removed,
      RelationshipChangeDtoSchema.parse(
        fixtures.relationshipChange({ isFollowing: true, friendRequest: 'none' }),
      ),
    )
    expect(followed.relationship.isFollowing).toBe(true)
    expect(followed.relationship.isFriend).toBe(false)
    const blocked = applyRelationshipChange(
      removed,
      RelationshipChangeDtoSchema.parse(fixtures.relationshipChange({ friendRequest: 'none' })),
      true,
    )
    expect(blocked.relationship.isBlocked).toBe(true)
    expect(blocked.canMessage).toBe(false)
    expect(profileActionsAvailable(blocked)).toBe(false)
    expect(profileActionsAvailable(profile)).toBe(true)
    expect(
      profileActionsAvailable({
        ...profile,
        relationship: { ...profile.relationship, isSelf: true },
      }),
    ).toBe(false)
  })
})
