/**
 * Profile visibility — mirror of `earth.identity_visible_to(target, viewer)` (migration 0160) as
 * used by the `public_identities` select policy and `profile_get` (DB_API §1; spec §17, §43).
 *
 * Own row always (a pending Human sees itself during the claim); otherwise the target must be an
 * active Human, no block either way, and `public` → anyone, `limited` → signed-in Humans,
 * `hidden` → friends only. Pending Humans are invisible everywhere (ARCHITECTURE §4).
 */
import type { ProfileVisibilityInput, Viewer } from './types'

export function canViewProfile(viewer: Viewer, profile: ProfileVisibilityInput): boolean {
  if (viewer.kind === 'service') return true
  const hasIdentity = viewer.kind === 'human' || viewer.kind === 'claiming'
  if (hasIdentity && viewer.relationToAuthor === 'self') return true
  if (profile.humanStatus !== 'active') return false
  if (viewer.blockedEitherWay) return false
  switch (profile.profileVisibility) {
    case 'public':
      return true
    case 'limited':
      return viewer.kind === 'human'
    case 'hidden':
      return viewer.kind === 'human' && viewer.relationToAuthor === 'friend'
  }
}
