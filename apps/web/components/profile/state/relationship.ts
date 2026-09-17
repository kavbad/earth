/**
 * Profile actions (SCREEN 22): which friend / follow affordance to show from the viewer's side
 * of the relationship, and how a `RelationshipChangeDto` answer folds back into the cached
 * profile. Friend is not Follow (spec §128); both are shown, neither implies the other.
 */
import type { ProfileDto, RelationshipChangeDto, RelationshipFlagsDto } from '@earth/domain'

export const FRIEND_ACTIONS = ['add', 'requested', 'accept', 'friends'] as const
export type FriendAction = (typeof FRIEND_ACTIONS)[number]

/** `Add Friend` · `Requested` · `Accept` (they asked) · `Friends`. */
export function friendActionFor(relationship: RelationshipFlagsDto): FriendAction {
  if (relationship.isFriend) return 'friends'
  switch (relationship.friendRequest) {
    case 'sent':
      return 'requested'
    case 'received':
      return 'accept'
    case 'none':
      return 'add'
  }
}

/** The profile after a relationship RPC answered (blocks clear every edge, spec §21). */
export function applyRelationshipChange(
  profile: ProfileDto,
  change: RelationshipChangeDto,
  isBlocked: boolean = profile.relationship.isBlocked,
): ProfileDto {
  const wasFriend = profile.relationship.isFriend
  const friendsDelta = change.isFriend === wasFriend ? 0 : change.isFriend ? 1 : -1
  return {
    ...profile,
    relationship: {
      ...profile.relationship,
      isFriend: change.isFriend,
      friendRequest: change.friendRequest,
      isFollowing: change.isFollowing,
      isBlocked,
    },
    counts: { ...profile.counts, friends: Math.max(0, profile.counts.friends + friendsDelta) },
    canMessage: isBlocked ? false : profile.canMessage,
  }
}

/** Which actions a viewer may take on a profile (self and blocked profiles show none). */
export function profileActionsAvailable(profile: ProfileDto): boolean {
  return !profile.relationship.isSelf && !profile.relationship.isBlocked
}
