/**
 * Client-side room state helpers (ARCHITECTURE §10, spec §57–§59, SCREEN 14–16, §109).
 *
 * NOT authoritative. The database (`room_join`, `room_set_visibility`, `room_consent`) enforces
 * every rule; these helpers let clients decide which affordance to show ("Join them" vs "Join on
 * camera") and which consent sheet to open before calling the RPC. A `false` here hides a button;
 * a `true` here still ends in the RPC's own check.
 */
import { discoveryScopeForVisibility, needsConsent, widerVisibilityOf } from '../audience'
import type { MediaState, RoomJoinPolicy, RoomVisibility, Scope } from '../enums'
import type { EarthErrorCode } from '../errors'

// ---------------------------------------------------------------------------
// Join affordance
// ---------------------------------------------------------------------------

/** What the viewer is to the room, as the client knows it. */
export interface ViewerRelationToRoom {
  /** Member of the group the room belongs to (group rooms). */
  readonly isMember: boolean
  /** Direct friend of at least one consenting audio/camera Human participant (spec §58). */
  readonly isFriendOfParticipant: boolean
  /** Friend of a friend of a consenting participant (`friends_of_friends` / `extended`). */
  readonly isFriendOfFriendOfParticipant?: boolean
  /** Has an `invited` participant row (direct rooms, explicit invites). */
  readonly isInvited: boolean
  /** Arrived through an unexpired room invite link (`/live/:token`). */
  readonly hasLink: boolean
}

export interface CanJoinWithMediaInput {
  readonly visibility: RoomVisibility
  readonly joinPolicy: RoomJoinPolicy
  readonly viewerRelationToRoom: ViewerRelationToRoom
  readonly isGuest: boolean
  readonly guestsDisabled: boolean
  readonly mediaState: MediaState
}

export interface JoinDecision {
  readonly allowed: boolean
  /** The error the RPC would raise; set only when `allowed` is `false`. */
  readonly reason?: EarthErrorCode
  /** `request` policy: the join creates a `waiting` participant a moderator must admit. */
  readonly requiresApproval?: boolean
}

function allow(requiresApproval = false): JoinDecision {
  return requiresApproval ? { allowed: true, requiresApproval: true } : { allowed: true }
}

function deny(reason: EarthErrorCode): JoinDecision {
  return { allowed: false, reason }
}

/** Whether the room is visible to the viewer at all (mirror of `earth.room_visible_to`). */
export function isRoomVisibleTo(
  visibility: RoomVisibility,
  relation: ViewerRelationToRoom,
  isGuest: boolean,
): boolean {
  // Guests exist only inside the room a link brought them to.
  if (isGuest) return relation.hasLink
  const invited = relation.isInvited || relation.hasLink
  switch (visibility) {
    case 'invited':
      return invited
    case 'group':
      return invited || relation.isMember
    case 'friends':
      return invited || relation.isMember || relation.isFriendOfParticipant
    case 'extended':
      return (
        invited ||
        relation.isMember ||
        relation.isFriendOfParticipant ||
        relation.isFriendOfFriendOfParticipant === true
      )
    case 'neighborhood':
    case 'city':
    case 'world':
      return true
  }
}

/** Whether the join policy lets the viewer publish (mirror of `room_join`'s policy branch). */
function joinPolicyAllows(policy: RoomJoinPolicy, relation: ViewerRelationToRoom): JoinDecision {
  const invited = relation.isInvited || relation.hasLink
  switch (policy) {
    case 'invited_only':
      return invited ? allow() : deny('join_not_allowed')
    case 'group':
      return invited || relation.isMember ? allow() : deny('join_not_allowed')
    case 'friends':
      return invited || relation.isMember || relation.isFriendOfParticipant
        ? allow()
        : deny('join_not_allowed')
    case 'friends_of_friends':
      return invited ||
        relation.isMember ||
        relation.isFriendOfParticipant ||
        relation.isFriendOfFriendOfParticipant === true
        ? allow()
        : deny('join_not_allowed')
    case 'request':
      return invited || relation.isMember ? allow() : allow(true)
    case 'anyone_with_link':
      return invited ? allow() : deny('join_not_allowed')
    case 'anyone':
      return allow()
  }
}

/**
 * Can the viewer enter the room with `mediaState`? Watching only needs visibility (spec §59:
 * "Default: viewer"); audio/camera also need the join policy. Guests need a link and guests not
 * disabled (SCREEN 17/18). Consent is a separate step (`requiresConsent`).
 */
export function canJoinWithMedia(input: CanJoinWithMediaInput): JoinDecision {
  const relation = input.viewerRelationToRoom
  if (input.isGuest) {
    if (input.guestsDisabled) return deny('guests_disabled')
    if (!relation.hasLink) return deny('guest_not_allowed')
  }
  if (!isRoomVisibleTo(input.visibility, relation, input.isGuest)) return deny('not_visible')
  if (input.mediaState === 'watching') return allow()
  // A guest's link is their invitation; the policy check below honors `hasLink`.
  return joinPolicyAllows(input.joinPolicy, relation)
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export interface RequiresConsentInput {
  readonly roomVisibility: RoomVisibility
  /** The viewer's recorded `audience_consent_level`; `null` before any consent. */
  readonly myConsentLevel: RoomVisibility | null
  readonly mediaState: MediaState
}

/** Narrowest visibility: a participant who never consented is treated as consenting to nothing wider. */
const NO_CONSENT: RoomVisibility = 'invited'

/**
 * Whether the consent sheet (SCREEN 16) must be shown before publishing at `roomVisibility`.
 * Viewers never need consent (ARCHITECTURE §10).
 */
export function requiresConsent(input: RequiresConsentInput): boolean {
  return needsConsent(input.mediaState, input.myConsentLevel ?? NO_CONSENT, input.roomVisibility)
}

/**
 * The consent level to ask for: the room's visibility, or its pending (wider) visibility when an
 * Open up is awaiting participants (ARCHITECTURE §10 "Widening is only ever applied by this
 * evaluation").
 */
export function nextConsentLevelFor(
  visibility: RoomVisibility,
  pendingVisibility: RoomVisibility | null = null,
): RoomVisibility {
  return pendingVisibility === null ? visibility : widerVisibilityOf(visibility, pendingVisibility)
}

// ---------------------------------------------------------------------------
// Visibility descriptions (SCREEN 15 "Clear explanatory microcopy")
// ---------------------------------------------------------------------------

export interface VisibilityDescription {
  readonly visibility: RoomVisibility
  /** Short label as offered by the Open up sheet. */
  readonly label: string
  /** One sentence explaining who can see the room. */
  readonly description: string
  /** The radius in which the room is discoverable, or `null` when it only lives in its context. */
  readonly scope: Scope | null
  readonly discoverable: boolean
}

const VISIBILITY_LABEL: Readonly<Record<RoomVisibility, string>> = {
  invited: 'Just us',
  group: 'Group',
  friends: 'Friends',
  extended: 'Friends of friends',
  neighborhood: 'Neighborhood',
  city: 'City',
  world: 'World',
}

const VISIBILITY_DESCRIPTION: Readonly<Record<RoomVisibility, string>> = {
  invited: 'Only people invited to this room can see it.',
  group: 'Only members of this group can see this room.',
  friends: 'Friends of everyone on camera can see this room.',
  extended: 'Friends of everyone on camera, and their friends, can see this room.',
  neighborhood: 'People in this neighborhood on Earth can see this room.',
  city: 'People in this city on Earth can see this room.',
  world: 'Anyone on Earth can see this room.',
}

export function describeVisibility(visibility: RoomVisibility): VisibilityDescription {
  const scope = discoveryScopeForVisibility(visibility)
  return {
    visibility,
    label: VISIBILITY_LABEL[visibility],
    description: VISIBILITY_DESCRIPTION[visibility],
    scope,
    discoverable: scope !== null,
  }
}

// ---------------------------------------------------------------------------
// Reconnect (spec §109; ARCHITECTURE §8 LiveKit states)
// ---------------------------------------------------------------------------

/** Automatic reconnect: five attempts with exponential backoff, then "Couldn't reconnect". */
export const RECONNECT_POLICY = {
  attempts: 5,
  backoffMs: [500, 1000, 2000, 4000, 8000],
} as const satisfies { attempts: number; backoffMs: readonly number[] }

/** Delay before reconnect `attempt` (1-based); `null` once the attempts are exhausted. */
export function reconnectDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > RECONNECT_POLICY.attempts) return null
  return RECONNECT_POLICY.backoffMs[attempt - 1] ?? null
}
