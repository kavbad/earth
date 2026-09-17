/**
 * A room link opened in the app (spec §112, SCREEN 17 on a phone with Earth installed): what
 * the preview says and which actions it offers. Humans join through `room_invite_join`; a
 * Visitor sees the faces, "Claim your place", and — when the room takes Guests and the flag is
 * on — a way to the web Guest page, since Guests join from the web. Pure.
 */
import { FeatureFlag, type FeatureFlags } from '@earth/config'
import type { MediaState, RoleKind, RoomInvitePreviewDto } from '@earth/domain'
import { copy } from '@earth/ui'

import { roomCopy } from '../copy'

export const INVITE_ACTIONS = ['join_camera', 'join_audio', 'watch', 'guest_web', 'claim'] as const
export type InviteAction = (typeof INVITE_ACTIONS)[number]

export type InvitePreview = Pick<
  RoomInvitePreviewDto,
  | 'ended'
  | 'guestsAllowed'
  | 'participants'
  | 'contextTitle'
  | 'invitedByDisplayName'
  | 'joinPolicy'
>

export interface InviteActionsInput {
  readonly preview: InvitePreview
  readonly roleKind: RoleKind
  readonly flags: FeatureFlags
}

/** The actions in display order; empty once the room has ended. */
export function inviteActions(input: InviteActionsInput): InviteAction[] {
  const { preview, roleKind, flags } = input
  if (preview.ended) return []
  if (roleKind === 'human') return ['join_camera', 'join_audio', 'watch']
  const actions: InviteAction[] = []
  if (preview.guestsAllowed && flags[FeatureFlag.GUEST_ROOMS_ENABLED]) actions.push('guest_web')
  actions.push('claim')
  return actions
}

/** The media state a join action asks for. */
export function mediaStateForAction(action: InviteAction): MediaState | null {
  switch (action) {
    case 'join_camera':
      return 'camera'
    case 'join_audio':
      return 'audio'
    case 'watch':
      return 'watching'
    default:
      return null
  }
}

/** "Weekend Crew is live" / "Xavier + Kavon are live" / "Live". */
export function invitePreviewTitle(
  preview: Pick<InvitePreview, 'contextTitle' | 'participants'>,
): string {
  if (preview.contextTitle !== null) return copy.groupLiveTitle(preview.contextTitle)
  const names = preview.participants.map((participant) => participant.displayName)
  const title = copy.liveTitle(names, preview.participants.length)
  return title.length > 0 ? title : copy.tabs.live
}

/** "Shared by Maya · Who can join: Friends". */
export function invitePreviewMeta(
  preview: Pick<InvitePreview, 'invitedByDisplayName' | 'joinPolicy'>,
): string {
  const parts: string[] = []
  if (preview.invitedByDisplayName !== null) {
    parts.push(roomCopy.invitedBy(preview.invitedByDisplayName))
  }
  parts.push(roomCopy.joinPolicyLine(copy.joinPolicies[preview.joinPolicy]))
  return parts.join(' · ')
}

/** The first face on the preview — the name SCREEN 16 opens with when a Human joins from a link. */
export function invitePreviewHost(
  preview: Pick<InvitePreview, 'invitedByDisplayName' | 'participants'>,
): string | null {
  return preview.invitedByDisplayName ?? preview.participants[0]?.displayName ?? null
}
