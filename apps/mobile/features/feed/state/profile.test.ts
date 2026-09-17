/**
 * SCREEN 22: which friend affordance the viewer sees, how a relationship answer folds into the
 * cached profile, the relation `profile_viewed` reports, the connection and counts lines, and
 * the "Now" pages.
 */
import { type PostViewDto, type ProfileDto, asHumanId, asPostId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  applyRelationshipChange,
  friendActionFor,
  mergeProfilePostPages,
  profileActionsAvailable,
  profileConnectionLine,
  profileCountsLine,
  viewerRelationFor,
} from './profile'

const MAYA = asHumanId('11111111-1111-4111-8111-111111111111')
const NOW = '2026-09-03T06:00:00.000Z'

const profile: ProfileDto = {
  identity: {
    humanId: MAYA,
    displayName: 'Maya',
    handle: 'maya',
    avatarUrl: null,
    bio: null,
    cityName: 'San Francisco',
    profileVisibility: 'public',
  },
  relationship: {
    isSelf: false,
    isFriend: false,
    friendRequest: 'none',
    isFollowing: false,
    isFollowedBy: false,
    isBlocked: false,
  },
  mutualFriendCount: 8,
  sharedGroupCount: 2,
  counts: { friends: 12, followers: 40, following: 7, posts: 3 },
  canMessage: true,
}

function view(id: string): PostViewDto {
  const postId = asPostId(id)
  return {
    post: {
      id: postId,
      authorHumanId: MAYA,
      type: 'text',
      text: 'hi',
      audience: 'friends',
      areaId: null,
      placeId: null,
      replyPolicy: 'everyone_eligible',
      resharePolicy: 'allowed_within_audience',
      parentPostId: null,
      rootPostId: null,
      createdAt: NOW,
      editedAt: null,
      deletedAt: null,
    },
    author: profile.identity,
    reactionCount: 0,
    replyCount: 0,
    myReaction: null,
    place: null,
    media: [],
  }
}

describe('friend affordance (Friend is not Follow)', () => {
  it('maps the viewer side of the relationship to one action', () => {
    expect(friendActionFor(profile.relationship)).toBe('add')
    expect(friendActionFor({ ...profile.relationship, friendRequest: 'sent' })).toBe('requested')
    expect(friendActionFor({ ...profile.relationship, friendRequest: 'received' })).toBe('accept')
    expect(friendActionFor({ ...profile.relationship, isFriend: true })).toBe('friends')
  })

  it('folds a relationship answer into the cached profile and moves the friend count', () => {
    const accepted = applyRelationshipChange(profile, {
      humanId: MAYA,
      isFriend: true,
      friendRequest: 'none',
      isFollowing: false,
      updatedAt: NOW,
    })
    expect(accepted.relationship.isFriend).toBe(true)
    expect(accepted.counts.friends).toBe(13)
    const removed = applyRelationshipChange(accepted, {
      humanId: MAYA,
      isFriend: false,
      friendRequest: 'none',
      isFollowing: true,
      updatedAt: NOW,
    })
    expect(removed.counts.friends).toBe(12)
    expect(removed.relationship.isFollowing).toBe(true)
  })

  it('a block clears messaging and hides the actions', () => {
    const blocked = applyRelationshipChange(
      profile,
      { humanId: MAYA, isFriend: false, friendRequest: 'none', isFollowing: false, updatedAt: NOW },
      true,
    )
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

describe('profile_viewed relation and the lines', () => {
  it('self, friend, shared group, other', () => {
    expect(viewerRelationFor(profile)).toBe('shared_group')
    expect(viewerRelationFor({ ...profile, sharedGroupCount: 0 })).toBe('other')
    expect(
      viewerRelationFor({ ...profile, relationship: { ...profile.relationship, isFriend: true } }),
    ).toBe('friend')
    expect(
      viewerRelationFor({ ...profile, relationship: { ...profile.relationship, isSelf: true } }),
    ).toBe('self')
  })

  it('joins mutual friends and shared groups, nothing for self', () => {
    const line = profileConnectionLine(
      profile,
      (count) => `${count} mutual friends`,
      (count) => `${count} shared groups`,
    )
    expect(line).toBe('8 mutual friends · 2 shared groups')
    expect(
      profileConnectionLine(
        { ...profile, sharedGroupCount: 0 },
        (count) => `${count} mutual friends`,
        (count) => `${count} shared groups`,
      ),
    ).toBe('8 mutual friends')
    expect(
      profileConnectionLine(
        { ...profile, relationship: { ...profile.relationship, isSelf: true } },
        (count) => `${count}`,
        (count) => `${count}`,
      ),
    ).toBe('')
  })

  it('keeps follower numbers on one secondary line', () => {
    expect(
      profileCountsLine(profile, {
        friends: (count) => `${count} friends`,
        followers: (count) => `${count} followers`,
        following: (count) => `${count} following`,
      }),
    ).toBe('12 friends · 40 followers · 7 following')
  })
})

describe('mergeProfilePostPages', () => {
  it('keeps the server order and drops a post repeated by an overlapping page', () => {
    const a = view('66666666-6666-4666-8666-666666666661')
    const b = view('66666666-6666-4666-8666-666666666662')
    const merged = mergeProfilePostPages([{ posts: [a, b] }, { posts: [b] }])
    expect(merged.map((item) => item.post.id)).toEqual([a.post.id, b.post.id])
    expect(mergeProfilePostPages([])).toEqual([])
  })
})
