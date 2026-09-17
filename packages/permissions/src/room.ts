/**
 * Room visibility and joining — mirror of `earth.room_visible_to` (migration 0310),
 * `earth.room_readable_by_caller`, `room_join` / `earth.room_join_human` / `room_invite_join` and
 * `guest_session_create` (migration 0330). DB_API §3; ARCHITECTURE §10; spec §32–§36, §57–§59,
 * §128 "Guest is not Human", "Blocks override all discovery".
 */
import { consentSatisfies } from '@earth/domain'

import {
  DEFAULT_PERMISSION_FLAGS,
  allow,
  assertHumanFailure,
  deny,
  type JoinAttempt,
  type PermissionDecision,
  type PermissionFlags,
  type RoomJoinInput,
  type RoomViewInput,
  type Viewer,
} from './types'

function isLive(room: RoomViewInput): boolean {
  const status = room.status ?? 'active'
  return status === 'starting' || status === 'active'
}

function isEnded(room: RoomViewInput): boolean {
  return (room.status ?? 'active') === 'ended'
}

/**
 * Whether the room exists for the viewer (`room_get`, `rooms` RLS, Live discovery).
 *
 * Humans: a live seat always sees its room; otherwise blocks with any consenting publishing
 * participant hide it; group members see their group's room; beyond that only live rooms are
 * discoverable, by the friend-graph union of consenting participants (`friends`), their friends
 * (`extended`), the viewer's area context (`neighborhood` / `city`) or anyone (`world`).
 * Guests exist only inside the room their session belongs to. Visitors and claiming Humans see
 * World Lives while `PUBLIC_LIVE_ENABLED`.
 */
export function canViewRoom(
  viewer: Viewer,
  room: RoomViewInput,
  flags: PermissionFlags = DEFAULT_PERMISSION_FLAGS,
): boolean {
  switch (viewer.kind) {
    case 'service':
      return true
    case 'guest':
      // A usable session (guests are removed when guests are disabled), or a link that can still
      // create one (`guest_session_create`: flag, room not ended, guests allowed).
      if (viewer.isInvitedParticipant === true) return !room.guestsDisabled
      return (
        viewer.hasLink === true &&
        flags.guestRoomsEnabled &&
        !room.guestsDisabled &&
        !isEnded(room) &&
        !viewer.blockedEitherWay
      )
    case 'visitor':
    case 'claiming':
      return isLive(room) && room.visibility === 'world' && flags.publicLiveEnabled
    case 'human':
      return humanCanViewRoom(viewer, room)
  }
}

function humanCanViewRoom(viewer: Viewer, room: RoomViewInput): boolean {
  if (viewer.isInvitedParticipant === true) return true
  if (viewer.blockedEitherWay) return false
  if (viewer.isGroupMember === true) return true
  if (!isLive(room)) return false
  switch (room.visibility) {
    case 'invited':
    case 'group':
      return false
    case 'friends':
      return viewer.isFriendOfConsentingParticipant === true
    case 'extended':
      return (
        viewer.isFriendOfConsentingParticipant === true ||
        viewer.isFriendOfFriendOfConsentingParticipant === true
      )
    case 'neighborhood':
      return (
        viewer.isFriendOfConsentingParticipant === true ||
        viewer.isFriendOfFriendOfConsentingParticipant === true ||
        viewer.sameNeighborhood === true
      )
    case 'city':
      return (
        viewer.isFriendOfConsentingParticipant === true ||
        viewer.isFriendOfFriendOfConsentingParticipant === true ||
        viewer.sameCity === true ||
        viewer.sameNeighborhood === true
      )
    case 'world':
      return true
  }
}

/**
 * Whether the join policy admits a Human who wants to publish (mirror of the `case v_policy`
 * branch of `earth.room_join_human`). Watching participants never pass through here.
 */
function joinPolicyAdmits(viewer: Viewer, room: RoomJoinInput): PermissionDecision {
  const invited = viewer.hasLink === true || viewer.isInvitedParticipant === true
  const member = viewer.isGroupMember === true
  const friend = viewer.isFriendOfConsentingParticipant === true
  const friendOfFriend = friend || viewer.isFriendOfFriendOfConsentingParticipant === true
  switch (room.joinPolicy) {
    case 'invited_only':
      return invited ? allow() : deny('join_not_allowed')
    case 'group':
      return invited || member ? allow() : deny('join_not_allowed')
    case 'friends':
      return invited || member || friend ? allow() : deny('join_not_allowed')
    case 'friends_of_friends':
      return invited || member || friendOfFriend ? allow() : deny('join_not_allowed')
    case 'request':
      return invited || member ? allow() : allow(true)
    case 'anyone_with_link':
      return invited ? allow() : deny('join_not_allowed')
    case 'anyone':
      return allow()
  }
}

/**
 * Whether `room_join` (or `room_invite_join` when `viewer.hasLink`, or `guest_session_create` for
 * a Guest with a link) would seat the viewer, and otherwise the error it raises.
 *
 * Humans: the room must be visible (or reached by a link without a block) and not ended; watching
 * needs nothing more (spec §59 "Default: viewer"); audio/camera pass the join policy and then the
 * consent gate (`consent_level >= visibility`, ARCHITECTURE §10). Guests never evaluate the policy
 * or consent: the link is their invitation and their consent is set to the room's visibility.
 */
export function canJoinRoom(
  viewer: Viewer,
  room: RoomJoinInput,
  attempt: JoinAttempt,
  flags: PermissionFlags = DEFAULT_PERMISSION_FLAGS,
): PermissionDecision {
  if (viewer.kind === 'guest') return guestCanJoinRoom(viewer, room, flags)
  const failure = assertHumanFailure(viewer.kind)
  if (failure !== null) return deny(failure)

  const reachable =
    canViewRoom(viewer, room, flags) || (viewer.hasLink === true && !viewer.blockedEitherWay)
  if (!reachable) return deny('room_not_found')
  if (isEnded(room)) return deny('room_ended')
  if (attempt.mediaState === 'watching') return allow()

  const policy = joinPolicyAdmits(viewer, room)
  if (!policy.allowed) return policy
  if (!consentSatisfies(attempt.consentLevel, room.visibility)) return deny('consent_required')
  return policy
}

function guestCanJoinRoom(
  viewer: Viewer,
  room: RoomJoinInput,
  flags: PermissionFlags,
): PermissionDecision {
  if (viewer.isInvitedParticipant === true) {
    // `room_join` with an existing session (re-entering, changing media).
    if (isEnded(room)) return deny('room_ended')
    if (room.guestsDisabled) return deny('guests_disabled')
    return allow()
  }
  if (viewer.hasLink !== true) return deny('guest_not_allowed')
  // `guest_session_create(token, display_name)`.
  if (!flags.guestRoomsEnabled) return deny('feature_disabled')
  if (isEnded(room)) return deny('room_ended')
  if (room.guestsDisabled) return deny('guests_disabled')
  if (viewer.blockedEitherWay) return deny('blocked')
  return allow()
}
