/**
 * @earth/permissions — `canViewObject` and friends: the TypeScript mirror of the database policy
 * (ARCHITECTURE §1 rule-home table; spec §71). The database enforces; this package lets the server
 * and clients decide affordances, and shares `fixtures/*.json` with `supabase/tests` so the two
 * cannot drift silently (DB_API §11). A `false` here hides a button; a `true` here still ends in
 * the database's own check.
 */
import { canReadConversation } from './conversation'
import { canPreviewInviteMember } from './group'
import { canViewPost } from './post'
import { canViewProfile } from './profile'
import { canViewRoom } from './room'
import { DEFAULT_PERMISSION_FLAGS, type CanViewObjectInput } from './types'

export const PACKAGE_NAME = '@earth/permissions' as const

export * from './types'
export * from './post'
export * from './room'
export * from './profile'
export * from './conversation'
export * from './group'
export * from './reshare'
export * from './fixtures'

/** The canonical permission function of spec §71, dispatching on `object.type`. */
export function canViewObject({ viewer, object, flags }: CanViewObjectInput): boolean {
  const resolvedFlags = flags ?? DEFAULT_PERMISSION_FLAGS
  switch (object.type) {
    case 'post':
      return canViewPost(viewer, object, resolvedFlags)
    case 'room':
      return canViewRoom(viewer, object, resolvedFlags)
    case 'profile':
      return canViewProfile(viewer, object)
    case 'conversation':
      return canReadConversation(viewer, object)
    case 'group_invite_preview':
      return canPreviewInviteMember(viewer, object)
  }
}
