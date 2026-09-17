/**
 * Post visibility — mirror of `earth.can_view_post(post_id, viewer)` (migration 0410; DB_API §4;
 * spec §29, §71, §72, §74).
 *
 * Order of the database checks, kept verbatim: author self → true; `status = 'active'`; block
 * either way → false; audience of the ROOT post (replies never widen); `world` reaches signed-in
 * Humans always and visitors while `PUBLIC_WORLD_ENABLED`; friends of the author always qualify;
 * `neighborhood` / `city` compare the viewer's area context (never coordinates).
 */
import type { Audience } from '@earth/domain'

import {
  DEFAULT_PERMISSION_FLAGS,
  type PermissionFlags,
  type PostVisibilityInput,
  type Viewer,
} from './types'

/** The audience a post is gated by: its root's for replies (spec §72). */
export function effectivePostAudience(post: PostVisibilityInput): Audience {
  return post.isReply ? (post.rootAudience ?? post.audience) : post.audience
}

/**
 * Whether `viewer` may read `post` directly (`post_get`, `posts` RLS). Hides do not apply here:
 * a hidden post is still readable when opened; see `canViewPostInFeed`.
 */
export function canViewPost(
  viewer: Viewer,
  post: PostVisibilityInput,
  flags: PermissionFlags = DEFAULT_PERMISSION_FLAGS,
): boolean {
  if (viewer.kind === 'service') return true
  const signedIn = viewer.kind === 'human'
  if (signedIn && viewer.relationToAuthor === 'self') return true
  if (post.status !== 'active') return false
  // Blocks override everything (spec §21, §128). Fail closed for any caller kind.
  if (viewer.blockedEitherWay) return false

  const audience = effectivePostAudience(post)
  if (audience === 'world') return signedIn || flags.publicWorldEnabled
  // Visitors, Guests and claiming Humans have no social graph and no area context.
  if (!signedIn) return false
  if (viewer.relationToAuthor === 'friend') return true
  switch (audience) {
    case 'friends':
      return false
    case 'neighborhood':
      return viewer.sameNeighborhood === true
    case 'city':
      return viewer.sameCity === true || viewer.sameNeighborhood === true
  }
}

/** Whether the post appears in the viewer's feeds: readable and not hidden by them (DB_API §4). */
export function canViewPostInFeed(
  viewer: Viewer,
  post: PostVisibilityInput,
  flags: PermissionFlags = DEFAULT_PERMISSION_FLAGS,
): boolean {
  if (post.hiddenByViewer === true && viewer.kind !== 'service') return false
  return canViewPost(viewer, post, flags)
}
