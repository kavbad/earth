/**
 * Profile state (SCREEN 22): which friend / follow affordance to show from the viewer's side of
 * the relationship, how a `RelationshipChangeDto` answer folds back into the cached profile, the
 * viewer relation reported by `profile_viewed`, the connection line, and the "Now / posts" pages
 * from `posts_by_author`. Friend is not Follow (spec §128): both are shown, neither implies the
 * other. Pure.
 */
import type {
  PostViewDto,
  ProfileDto,
  RelationshipChangeDto,
  RelationshipFlagsDto,
  ViewerRelation,
} from '@earth/domain'

// ---------------------------------------------------------------------------
// Relationship
// ---------------------------------------------------------------------------

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

export function viewerRelationFor(profile: ProfileDto): ViewerRelation {
  if (profile.relationship.isSelf) return 'self'
  if (profile.relationship.isFriend) return 'friend'
  if (profile.sharedGroupCount > 0) return 'shared_group'
  return 'other'
}

/** `8 mutual friends · 2 shared groups` for SCREEN 22; empty for self or when there is nothing. */
export function profileConnectionLine(
  profile: ProfileDto,
  mutualLine: (count: number) => string,
  sharedGroups: (count: number) => string,
): string {
  if (profile.relationship.isSelf) return ''
  return [
    profile.mutualFriendCount > 0 ? mutualLine(profile.mutualFriendCount) : '',
    profile.sharedGroupCount > 0 ? sharedGroups(profile.sharedGroupCount) : '',
  ]
    .filter((part) => part.length > 0)
    .join(' · ')
}

/** Follower numbers are visually secondary (SCREEN 22): one meta line, joined with dots. */
export function profileCountsLine(
  profile: ProfileDto,
  labels: {
    readonly friends: (count: number) => string
    readonly followers: (count: number) => string
    readonly following: (count: number) => string
  },
): string {
  return [
    labels.friends(profile.counts.friends),
    labels.followers(profile.counts.followers),
    labels.following(profile.counts.following),
  ].join(' · ')
}

// ---------------------------------------------------------------------------
// "Now / posts"
// ---------------------------------------------------------------------------

export const PROFILE_POSTS_LIMIT = 30

/** Every page's posts in the server's order (newest first), each id once. */
export function mergeProfilePostPages(
  pages: ReadonlyArray<{ readonly posts: readonly PostViewDto[] }>,
): PostViewDto[] {
  const seen = new Set<string>()
  const posts: PostViewDto[] = []
  for (const page of pages) {
    for (const view of page.posts) {
      if (seen.has(view.post.id)) continue
      seen.add(view.post.id)
      posts.push(view)
    }
  }
  return posts
}
