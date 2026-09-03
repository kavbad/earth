/**
 * Consent affordances (SCREEN 16; ARCHITECTURE §10) on top of `@earth/domain`'s room helpers.
 * NOT authoritative: the database's `room_join` / `room_set_media_state` / `room_consent` decide;
 * these helpers only pick which sheet to open and which `consent_level` to send.
 */
import {
  type MediaState,
  type ParticipantRole,
  type RoomDto,
  type RoomParticipantDto,
  type RoomVisibility,
  discoveryScopeForVisibility,
  nextConsentLevelFor,
  requiresConsent,
} from '@earth/domain'

export interface ConsentDecisionInput {
  readonly room: Pick<RoomDto, 'visibility' | 'pendingVisibility'>
  /** The viewer's recorded `audience_consent_level`; `null` before any consent. */
  readonly myConsentLevel: RoomVisibility | null
  readonly mediaState: MediaState
}

export interface ConsentDecision {
  /** The `consent_level` to send with the join / media-state change. */
  readonly level: RoomVisibility
  /** The RPC needs consent ≥ `level` (viewers never do). */
  readonly required: boolean
  /**
   * Whether SCREEN 16 must be shown first. Consent is asked explicitly only when the room is a
   * wider Live — discoverable beyond its own context (`friends` and up). Inside "Just us" and a
   * group's own room, publishing means exactly what the person expects and no sheet interrupts
   * the core loop; the consent level is still sent so the server's rule holds.
   */
  readonly showSheet: boolean
}

export function consentDecision(input: ConsentDecisionInput): ConsentDecision {
  const level = nextConsentLevelFor(input.room.visibility, input.room.pendingVisibility)
  const required = requiresConsent({
    roomVisibility: level,
    myConsentLevel: input.myConsentLevel,
    mediaState: input.mediaState,
  })
  const wider = discoveryScopeForVisibility(level) !== null
  return { level, required, showSheet: required && wider }
}

/** The narrowest level, sent when joining as a viewer. */
export const VIEWER_CONSENT_LEVEL: RoomVisibility = 'invited'

/**
 * A pending "Open up" that this publishing participant still has to answer (ARCHITECTURE §10:
 * `room_set_visibility` sets `pending_visibility` until every camera/audio Human consents).
 * `null` when nothing is pending for them.
 */
export function pendingConsentFor(
  room: Pick<RoomDto, 'visibility' | 'pendingVisibility'>,
  me: Pick<RoomParticipantDto, 'status' | 'mediaState' | 'audienceConsentLevel' | 'isGuest'> | null,
): RoomVisibility | null {
  if (me === null || room.pendingVisibility === null) return null
  if (me.status !== 'active' || me.isGuest) return null
  const needed = requiresConsent({
    roomVisibility: room.pendingVisibility,
    myConsentLevel: me.audienceConsentLevel,
    mediaState: me.mediaState,
  })
  return needed ? room.pendingVisibility : null
}

const MODERATOR_ROLES: ReadonlySet<ParticipantRole> = new Set<ParticipantRole>([
  'initiator',
  'moderator',
])

export function isModeratorRole(role: ParticipantRole): boolean {
  return MODERATOR_ROLES.has(role)
}

/** Initiator / moderator, active, and a Human — Guests never moderate (spec §61, SCREEN 18). */
export function canModerate(
  me: Pick<RoomParticipantDto, 'role' | 'status' | 'isGuest'> | null,
): boolean {
  return me !== null && me.status === 'active' && !me.isGuest && isModeratorRole(me.role)
}

/** Publishing audio or camera (a tile on stage). */
export function isPublishing(
  participant: Pick<RoomParticipantDto, 'status' | 'mediaState'>,
): boolean {
  return participant.status === 'active' && participant.mediaState !== 'watching'
}

/** A participant is in the room (a viewer or a publisher). */
export function isInRoom(participant: Pick<RoomParticipantDto, 'status'>): boolean {
  return participant.status === 'active'
}

/** Whether the viewer became moderator in this update (spec §61 "You're keeping the room open."). */
export function becameModerator(previous: ParticipantRole, next: ParticipantRole): boolean {
  return !isModeratorRole(previous) && isModeratorRole(next)
}

/** The name SCREEN 16 opens with: the initiator's, or the first person on camera. */
export function initiatorName(
  room: Pick<RoomDto, 'initiatedByHumanId' | 'participants'>,
): string | null {
  const initiator = room.participants.find((p) => p.humanId === room.initiatedByHumanId)
  if (initiator !== undefined) return initiator.displayName
  const onCamera = room.participants.find((p) => isPublishing(p) && p.mediaState === 'camera')
  return onCamera?.displayName ?? null
}
