import { describe, expect, it } from 'vitest'

import { RELATIONSHIP_TYPE } from '../enums'
import { CANDIDATE_RELATIONSHIPS, type CandidateRelationship } from '../feed/candidates'
import { RELATIONSHIP_SCORE } from '../feed/score'
import {
  BLOCK_OVERRIDE_RULES,
  BLOCK_OVERRIDES,
  blockOverrides,
  canAcceptFriendRequest,
  canFollow,
  canRemoveFriend,
  canSendFriendRequest,
  canUnfollow,
  edgesAfterAccept,
  edgesAfterBlock,
  feedRelationshipFor,
  FOLLOW_DOES_NOT_IMPLY_FRIEND,
  isFollowedBy,
  isFollowing,
  isFriend,
  isRelationshipVisibleTo,
  NO_EDGES,
  type RelationshipEdges,
  relationshipFlags,
  resolveFriendRequest,
  visibleRelationshipTypes,
} from './rules'

const friends: RelationshipEdges = { ab: ['friend'], ba: ['friend'] }
const sent: RelationshipEdges = { ab: ['friend_pending'], ba: [] }
const received: RelationshipEdges = { ab: [], ba: ['friend_pending'] }
const mutualPending: RelationshipEdges = { ab: ['friend_pending'], ba: ['friend_pending'] }
const following: RelationshipEdges = { ab: ['follow'], ba: [] }

describe('relationship resolution (spec §20, §128)', () => {
  it('resolves friend request state from the viewer side', () => {
    expect(resolveFriendRequest(NO_EDGES)).toBe('none')
    expect(resolveFriendRequest(sent)).toBe('sent')
    expect(resolveFriendRequest(received)).toBe('received')
    expect(resolveFriendRequest(mutualPending)).toBe('friend')
    expect(resolveFriendRequest(friends)).toBe('friend')
    expect(resolveFriendRequest({ ab: ['friend'], ba: [] })).toBe('friend')
  })

  it('follow does not imply friend', () => {
    expect(FOLLOW_DOES_NOT_IMPLY_FRIEND).toBe(true)
    expect(isFollowing(following)).toBe(true)
    expect(isFriend(following)).toBe(false)
    expect(resolveFriendRequest({ ab: ['follow'], ba: ['follow'] })).toBe('none')
    expect(isFollowedBy({ ab: [], ba: ['follow'] })).toBe(true)
    expect(isFollowing({ ab: [], ba: ['follow'] })).toBe(false)
  })

  it('friendship coexists with follow edges', () => {
    const both: RelationshipEdges = { ab: ['friend', 'follow'], ba: ['friend'] }
    expect(isFriend(both)).toBe(true)
    expect(isFollowing(both)).toBe(true)
  })
})

describe('transitions (mirror of friend_request_send / accept / follow_set)', () => {
  it('canSendFriendRequest', () => {
    expect(canSendFriendRequest(NO_EDGES, false)).toEqual({ kind: 'send' })
    expect(canSendFriendRequest(received, false)).toEqual({ kind: 'accept' })
    expect(canSendFriendRequest(sent, false)).toEqual({ kind: 'noop', because: 'already_sent' })
    expect(canSendFriendRequest(friends, false)).toEqual({
      kind: 'noop',
      because: 'already_friends',
    })
    expect(canSendFriendRequest(following, false)).toEqual({ kind: 'send' })
    expect(canSendFriendRequest(NO_EDGES, true)).toEqual({ kind: 'denied', reason: 'blocked' })
    expect(canSendFriendRequest(received, true)).toEqual({ kind: 'denied', reason: 'blocked' })
  })

  it('accept / remove / follow / unfollow', () => {
    expect(canAcceptFriendRequest(received, false)).toBe(true)
    expect(canAcceptFriendRequest(received, true)).toBe(false)
    expect(canAcceptFriendRequest(sent, false)).toBe(false)
    expect(canRemoveFriend(friends)).toBe(true)
    expect(canRemoveFriend(sent)).toBe(false)
    expect(canFollow(NO_EDGES, false)).toBe(true)
    expect(canFollow(following, false)).toBe(false)
    expect(canFollow(NO_EDGES, true)).toBe(false)
    expect(canUnfollow(following)).toBe(true)
    expect(canUnfollow(NO_EDGES)).toBe(false)
  })

  it('edgesAfterAccept writes friend both ways and drops pending', () => {
    expect(edgesAfterAccept(received)).toEqual({ ab: ['friend'], ba: ['friend'] })
    expect(edgesAfterAccept({ ab: ['follow'], ba: ['friend_pending'] })).toEqual({
      ab: ['follow', 'friend'],
      ba: ['friend'],
    })
  })

  it('edgesAfterBlock removes friend, pending and follow both ways (block_set)', () => {
    const rich: RelationshipEdges = {
      ab: ['friend', 'follow', 'familiar_private'],
      ba: ['friend', 'friend_pending', 'follow'],
    }
    expect(edgesAfterBlock(rich)).toEqual({ ab: ['familiar_private'], ba: [] })
    expect(isFriend(edgesAfterBlock(rich))).toBe(false)
    expect(isFollowing(edgesAfterBlock(rich))).toBe(false)
  })
})

describe('flags and feed relationship', () => {
  it('relationshipFlags mirrors RelationshipFlagsDto (isBlocked = blocked by viewer only)', () => {
    expect(relationshipFlags(friends, false)).toEqual({
      isFriend: true,
      friendRequest: 'none',
      isFollowing: false,
      isFollowedBy: false,
      isBlocked: false,
    })
    expect(relationshipFlags(sent, false)).toEqual({
      isFriend: false,
      friendRequest: 'sent',
      isFollowing: false,
      isFollowedBy: false,
      isBlocked: false,
    })
    expect(relationshipFlags({ ab: ['follow'], ba: ['follow', 'friend_pending'] }, true)).toEqual({
      isFriend: false,
      friendRequest: 'received',
      isFollowing: true,
      isFollowedBy: true,
      isBlocked: true,
    })
  })

  it('feedRelationshipFor: friend > follow > shared_group > none', () => {
    expect(feedRelationshipFor(friends, 3)).toBe('friend')
    expect(feedRelationshipFor(following, 3)).toBe('follow')
    expect(feedRelationshipFor(NO_EDGES, 2)).toBe('shared_group')
    expect(feedRelationshipFor(NO_EDGES, 0)).toBe('none')
    expect(feedRelationshipFor(sent, 0)).toBe('none')
  })

  it('feedRelationshipFor always returns the highest-scoring applicable relationship', () => {
    expect(CANDIDATE_RELATIONSHIPS).toEqual(['friend', 'follow', 'shared_group', 'none'])
    const combos: RelationshipEdges[] = [
      NO_EDGES,
      following,
      friends,
      sent,
      received,
      { ab: ['friend', 'follow'], ba: ['friend'] },
      { ab: ['follow'], ba: ['follow', 'friend_pending'] },
      { ab: ['familiar_private'], ba: [] },
    ]
    for (const edges of combos) {
      for (const sharedGroupCount of [0, 1, 4]) {
        const applicable: CandidateRelationship[] = ['none']
        if (isFriend(edges)) applicable.push('friend')
        if (isFollowing(edges)) applicable.push('follow')
        if (sharedGroupCount > 0) applicable.push('shared_group')
        const strongest = Math.max(...applicable.map((r) => RELATIONSHIP_SCORE[r]))
        const chosen = feedRelationshipFor(edges, sharedGroupCount)
        expect(applicable, JSON.stringify({ edges, sharedGroupCount })).toContain(chosen)
        expect(RELATIONSHIP_SCORE[chosen], JSON.stringify({ edges, sharedGroupCount })).toBe(
          strongest,
        )
      }
    }
  })
})

describe('visibility of relationship rows', () => {
  it('familiar_private is hidden from the target', () => {
    expect(visibleRelationshipTypes(false)).toEqual(RELATIONSHIP_TYPE)
    expect(visibleRelationshipTypes(true)).toEqual(['follow', 'friend_pending', 'friend'])
    expect(isRelationshipVisibleTo('familiar_private', true)).toBe(false)
    expect(isRelationshipVisibleTo('familiar_private', false)).toBe(true)
    expect(isRelationshipVisibleTo('friend', true)).toBe(true)
  })
})

describe('block overrides (spec §21, §128)', () => {
  it('lists every surface the spec names, each with a rule', () => {
    expect([...BLOCK_OVERRIDES].sort()).toEqual(
      [
        'feed',
        'friend_suggestions',
        'live_discovery',
        'location',
        'messaging',
        'notifications',
        'search',
      ].sort(),
    )
    for (const surface of BLOCK_OVERRIDES) {
      expect(BLOCK_OVERRIDE_RULES[surface].length).toBeGreaterThan(10)
      expect(blockOverrides(surface)).toBe(true)
    }
  })
})
