/**
 * Relationship rules (spec §20, §21, §128; DB_API §1). The database is authoritative
 * (`friend_request_send`, `friend_request_accept`, `follow_set`, `block_set`); this module mirrors
 * the transitions so clients show the right affordance and the server can reason about edges.
 *
 * Invariants (spec §128): Friend is not Follow; group member is not automatically Friend; blocks
 * override all discovery.
 */
import { RELATIONSHIP_TYPE, type FriendRequestState, type RelationshipType } from '../enums'
import type { EarthErrorCode } from '../errors'
import type { CandidateRelationship } from '../feed/candidates'

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

/**
 * Relationship rows between two Humans `a` (the viewer) and `b`, by direction. Friendship is
 * stored as two `friend` rows (one per direction, written in one transaction); `friend_pending`
 * is a single row from requester to target; `follow` and `familiar_private` are directional.
 */
export interface RelationshipEdges {
  /** Types of rows with `source = a`, `target = b`. */
  readonly ab: readonly RelationshipType[]
  /** Types of rows with `source = b`, `target = a`. */
  readonly ba: readonly RelationshipType[]
}

export const NO_EDGES: RelationshipEdges = { ab: [], ba: [] }

function has(edges: readonly RelationshipType[], type: RelationshipType): boolean {
  return edges.includes(type)
}

/** Friends when either direction carries `friend` (canonically both do). */
export function isFriend(edges: RelationshipEdges): boolean {
  return has(edges.ab, 'friend') || has(edges.ba, 'friend')
}

/** Follow is directional: `a` follows `b`. Following never implies friendship. */
export function isFollowing(edges: RelationshipEdges): boolean {
  return has(edges.ab, 'follow')
}

export function isFollowedBy(edges: RelationshipEdges): boolean {
  return has(edges.ba, 'follow')
}

/**
 * Documented invariant (spec §128 "Friend is not Follow"): a `follow` edge in either direction
 * contributes nothing to friendship, friend requests or friend-only audiences.
 */
export const FOLLOW_DOES_NOT_IMPLY_FRIEND = true as const

export type FriendRequestResolution = FriendRequestState | 'friend'

/**
 * The friend-request state from `a`'s side: `friend` when friends or when both sides have a
 * pending request (the database converts mutual pending into friendship on the second send),
 * `sent` when `a` asked, `received` when `b` asked, else `none`.
 */
export function resolveFriendRequest(edges: RelationshipEdges): FriendRequestResolution {
  if (isFriend(edges)) return 'friend'
  const sent = has(edges.ab, 'friend_pending')
  const received = has(edges.ba, 'friend_pending')
  if (sent && received) return 'friend'
  if (sent) return 'sent'
  if (received) return 'received'
  return 'none'
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export type FriendRequestOutcome =
  /** Inserts `friend_pending` a→b and notifies `b` (`friend_request`). */
  | { readonly kind: 'send' }
  /** A reverse pending exists: accepts it (both `friend` rows, `friend_accepted` to the requester). */
  | { readonly kind: 'accept' }
  /** Nothing to do. */
  | { readonly kind: 'noop'; readonly because: 'already_friends' | 'already_sent' }
  /** The RPC would raise `reason`. */
  | { readonly kind: 'denied'; readonly reason: EarthErrorCode }

/** Mirror of `friend_request_send` (DB_API §1). `blocked` is a block in either direction. */
export function canSendFriendRequest(
  edges: RelationshipEdges,
  blocked: boolean,
): FriendRequestOutcome {
  if (blocked) return { kind: 'denied', reason: 'blocked' }
  switch (resolveFriendRequest(edges)) {
    case 'friend':
      return { kind: 'noop', because: 'already_friends' }
    case 'sent':
      return { kind: 'noop', because: 'already_sent' }
    case 'received':
      return { kind: 'accept' }
    case 'none':
      return { kind: 'send' }
  }
}

export function canAcceptFriendRequest(edges: RelationshipEdges, blocked: boolean): boolean {
  return !blocked && resolveFriendRequest(edges) === 'received'
}

export function canRemoveFriend(edges: RelationshipEdges): boolean {
  return isFriend(edges)
}

export function canFollow(edges: RelationshipEdges, blocked: boolean): boolean {
  return !blocked && !isFollowing(edges)
}

export function canUnfollow(edges: RelationshipEdges): boolean {
  return isFollowing(edges)
}

/** Edges after `block_set(b, true)` by `a`: friend, pending and follow rows vanish both ways. */
export function edgesAfterBlock(edges: RelationshipEdges): RelationshipEdges {
  const keep = (types: readonly RelationshipType[]): RelationshipType[] =>
    types.filter((type) => type === 'familiar_private')
  return { ab: keep(edges.ab), ba: keep(edges.ba) }
}

/** After friend rows are written both ways (mirror of `friend_request_accept`). */
export function edgesAfterAccept(edges: RelationshipEdges): RelationshipEdges {
  const strip = (types: readonly RelationshipType[]): RelationshipType[] =>
    types.filter((type) => type !== 'friend_pending' && type !== 'friend')
  return { ab: [...strip(edges.ab), 'friend'], ba: [...strip(edges.ba), 'friend'] }
}

// ---------------------------------------------------------------------------
// Flags and feed relationship
// ---------------------------------------------------------------------------

/** `RelationshipFlagsDto` minus `isSelf`, derived from edges. */
export interface RelationshipFlags {
  readonly isFriend: boolean
  readonly friendRequest: FriendRequestState
  readonly isFollowing: boolean
  readonly isFollowedBy: boolean
  readonly isBlocked: boolean
}

/** `blockedByViewer` only — being blocked by `b` is never revealed to `a`. */
export function relationshipFlags(
  edges: RelationshipEdges,
  blockedByViewer: boolean,
): RelationshipFlags {
  const resolution = resolveFriendRequest(edges)
  return {
    isFriend: resolution === 'friend',
    friendRequest: resolution === 'friend' ? 'none' : resolution,
    isFollowing: isFollowing(edges),
    isFollowedBy: isFollowedBy(edges),
    isBlocked: blockedByViewer,
  }
}

/**
 * Feed candidate relationship: friend > follow > shared_group > none (spec §64) — the order of
 * `CANDIDATE_RELATIONSHIPS`, which `RELATIONSHIP_SCORE` in `../feed/score` follows monotonically.
 */
export function feedRelationshipFor(
  edges: RelationshipEdges,
  sharedGroupCount: number,
): CandidateRelationship {
  if (isFriend(edges)) return 'friend'
  if (isFollowing(edges)) return 'follow'
  if (sharedGroupCount > 0) return 'shared_group'
  return 'none'
}

// ---------------------------------------------------------------------------
// Visibility of relationship rows
// ---------------------------------------------------------------------------

/**
 * Relationship types a viewer may see on rows where they are the target (spec §20:
 * "`familiar_private` is not visible to the target"). As source, every type is visible.
 */
export function visibleRelationshipTypes(forTarget: boolean): readonly RelationshipType[] {
  return forTarget
    ? RELATIONSHIP_TYPE.filter((type) => type !== 'familiar_private')
    : RELATIONSHIP_TYPE
}

export function isRelationshipVisibleTo(type: RelationshipType, viewerIsTarget: boolean): boolean {
  return visibleRelationshipTypes(viewerIsTarget).includes(type)
}

// ---------------------------------------------------------------------------
// Block overrides (spec §21, §128 "Blocks override all discovery")
// ---------------------------------------------------------------------------

/** Every surface a block must override. Tests elsewhere iterate this list. */
export const BLOCK_OVERRIDES = [
  'feed',
  'search',
  'live_discovery',
  'messaging',
  'friend_suggestions',
  'location',
  'notifications',
] as const
export type BlockOverrideSurface = (typeof BLOCK_OVERRIDES)[number]

/** What "override" means on each surface, for the tests that assert it. */
export const BLOCK_OVERRIDE_RULES: Readonly<Record<BlockOverrideSurface, string>> = {
  feed: 'Neither Human sees the other’s posts or Lives in any radius (feed_candidates excludes both directions).',
  search: 'Neither Human appears in the other’s search results (people, posts, groups they own).',
  live_discovery:
    'A room with a consenting camera/audio participant blocked either way is not visible to the other.',
  messaging:
    'The blocked Human cannot send new direct messages; group coexistence remains but direct interactions are suppressed.',
  friend_suggestions:
    'Neither Human is suggested to the other; pending requests are deleted on block.',
  location: 'Location shares between the two are revoked on block and never visible afterwards.',
  notifications:
    'earth.notify skips blocked pairs; no notification is created in either direction.',
}

/** Blocks override every surface; there is no exception. */
export function blockOverrides(_surface: BlockOverrideSurface): true {
  return true
}
