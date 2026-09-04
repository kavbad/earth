/**
 * Group invite preview — mirror of the sample-member filter of `group_invite_preview`
 * (migration 0185; DB_API §2; spec §24, §46): "overlapping member names/photos allowed by privacy".
 *
 * A member is sampled when they are an active Human, not the viewer, not blocked either way, and
 * their profile is `public` or they are a friend of a Human viewer. `limited` profiles are not
 * previewed to strangers: the link is public and the preview is what a visitor sees.
 */
import type { InviteMemberInput, Viewer } from './types'

export function canPreviewInviteMember(viewer: Viewer, member: InviteMemberInput): boolean {
  if ((member.humanStatus ?? 'active') !== 'active') return false
  if (viewer.relationToAuthor === 'self') return false
  if (viewer.blockedEitherWay) return false
  if (member.profileVisibility === 'public') return true
  return (
    viewer.kind === 'human' && (member.isFriendOfViewer || viewer.relationToAuthor === 'friend')
  )
}
