/**
 * Audience and room visibility ordering (spec §29, §32, §72; ARCHITECTURE §10).
 *
 * The database enforces these rules; this module lets the server and clients decide
 * affordances (`isAudienceWithin` for the composer, consent checks for the Open up sheet).
 */
import {
  AUDIENCE,
  ROOM_VISIBILITY,
  type Audience,
  type MediaState,
  type RoomContextType,
  type RoomJoinPolicy,
  type RoomVisibility,
  type Scope,
} from './enums'

/** Post audiences ordered narrow → wide: friends < neighborhood < city < world. */
export const AUDIENCE_ORDER: readonly Audience[] = AUDIENCE

/** Room visibilities ordered narrow → wide: invited < group < friends < extended < neighborhood < city < world. */
export const ROOM_VISIBILITY_ORDER: readonly RoomVisibility[] = ROOM_VISIBILITY

const AUDIENCE_RANK: Readonly<Record<Audience, number>> = {
  friends: 0,
  neighborhood: 1,
  city: 2,
  world: 3,
}

const VISIBILITY_RANK: Readonly<Record<RoomVisibility, number>> = {
  invited: 0,
  group: 1,
  friends: 2,
  extended: 3,
  neighborhood: 4,
  city: 5,
  world: 6,
}

export function audienceRank(audience: Audience): number {
  return AUDIENCE_RANK[audience]
}

/** Negative when `a` is narrower than `b`, zero when equal, positive when wider. */
export function compareAudience(a: Audience, b: Audience): number {
  return AUDIENCE_RANK[a] - AUDIENCE_RANK[b]
}

/** True when `candidate` reaches no further than `limit` (spec §72: replies/reshares never widen). */
export function isAudienceWithin(candidate: Audience, limit: Audience): boolean {
  return AUDIENCE_RANK[candidate] <= AUDIENCE_RANK[limit]
}

export function widerOf(a: Audience, b: Audience): Audience {
  return compareAudience(a, b) >= 0 ? a : b
}

export function narrowerOf(a: Audience, b: Audience): Audience {
  return compareAudience(a, b) <= 0 ? a : b
}

/** True when moving from `from` to `to` widens the audience (composer confirmation, SCREEN 06). */
export function isWidening(from: Audience, to: Audience): boolean {
  return compareAudience(to, from) > 0
}

export function visibilityRank(visibility: RoomVisibility): number {
  return VISIBILITY_RANK[visibility]
}

/** Negative when `a` is narrower than `b`, zero when equal, positive when wider. */
export function compareVisibility(a: RoomVisibility, b: RoomVisibility): number {
  return VISIBILITY_RANK[a] - VISIBILITY_RANK[b]
}

/** True when `visibility` is at least as wide as `minimum`. */
export function isVisibilityAtLeast(visibility: RoomVisibility, minimum: RoomVisibility): boolean {
  return VISIBILITY_RANK[visibility] >= VISIBILITY_RANK[minimum]
}

export function widerVisibilityOf(a: RoomVisibility, b: RoomVisibility): RoomVisibility {
  return compareVisibility(a, b) >= 0 ? a : b
}

/**
 * Consent gate (ARCHITECTURE §10): a participant's `audience_consent_level` satisfies a room
 * visibility when it is at least as wide as that visibility.
 */
export function consentSatisfies(
  consentLevel: RoomVisibility,
  visibility: RoomVisibility,
): boolean {
  return isVisibilityAtLeast(consentLevel, visibility)
}

/**
 * Whether joining/staying with `mediaState` at `visibility` needs consent from a participant whose
 * current consent is `consentLevel`. Viewers (`watching`) never need consent.
 */
export function needsConsent(
  mediaState: MediaState,
  consentLevel: RoomVisibility,
  visibility: RoomVisibility,
): boolean {
  if (mediaState === 'watching') return false
  return !consentSatisfies(consentLevel, visibility)
}

/** The browsing radius maps 1:1 onto the audience it browses (spec §52). */
export function scopeToAudience(scope: Scope): Audience {
  return scope
}

/**
 * Room visibility → the feed/Live scope in which the room is discoverable, or `null` when it is
 * not discoverable at all (`invited`, `group` rooms only surface inside their context).
 * `extended` (friends of friends) surfaces in the Friends scope (spec SCREEN 13).
 */
export function discoveryScopeForVisibility(visibility: RoomVisibility): Scope | null {
  switch (visibility) {
    case 'invited':
    case 'group':
      return null
    case 'friends':
    case 'extended':
      return 'friends'
    case 'neighborhood':
      return 'neighborhood'
    case 'city':
      return 'city'
    case 'world':
      return 'world'
  }
}

/** Visibilities offered by the Open up sheet, narrow → wide (SCREEN 15). */
export function openUpOptionsFor(contextType: RoomContextType): readonly RoomVisibility[] {
  const base: RoomVisibility[] = ['friends', 'neighborhood', 'city', 'world']
  return contextType === 'group' ? ['group', ...base] : ['invited', ...base]
}

/** Default room visibility per context (ARCHITECTURE §10). */
export function defaultRoomVisibilityFor(contextType: RoomContextType): RoomVisibility {
  switch (contextType) {
    case 'group':
      return 'group'
    case 'direct':
      return 'invited'
    case 'standalone':
      return 'friends'
    case 'event':
    case 'place':
      // Reserved contexts: narrowest pair until the product specifies otherwise.
      return 'invited'
  }
}

/** Default join policy per context (ARCHITECTURE §10). */
export function defaultJoinPolicyFor(contextType: RoomContextType): RoomJoinPolicy {
  switch (contextType) {
    case 'group':
      return 'group'
    case 'direct':
      return 'invited_only'
    case 'standalone':
      return 'friends'
    case 'event':
    case 'place':
      return 'invited_only'
  }
}

/**
 * How far a join policy reaches, expressed as the room visibility it corresponds to. A policy is only
 * ever offered for a visibility it does not exceed: someone who cannot see a room cannot be let in
 * by its join policy, so `friends_of_friends` pairs with `extended` and wider, never with `friends`.
 * `null` policies are gated by the visibility itself (`request`: anyone who can see the room may
 * ask; `anyone` / `anyone_with_link`: anyone eligible under the visibility, or holding a link).
 */
export const JOIN_POLICY_REACH: Readonly<Record<RoomJoinPolicy, RoomVisibility | null>> = {
  invited_only: 'invited',
  group: 'group',
  friends: 'friends',
  friends_of_friends: 'extended',
  request: null,
  anyone_with_link: null,
  anyone: null,
}

/** True when `policy` reaches no further than `visibility` (see `JOIN_POLICY_REACH`). */
export function joinPolicyWithinVisibility(
  policy: RoomJoinPolicy,
  visibility: RoomVisibility,
): boolean {
  const reach = JOIN_POLICY_REACH[policy]
  return reach === null || VISIBILITY_RANK[reach] <= VISIBILITY_RANK[visibility]
}

/**
 * Join policies the UI offers for a given visibility (ARCHITECTURE §10: "Join policy is
 * independent but the UI only offers sensible pairs"; SCREEN 15 "Who can join — Invite only,
 * Group, Friends, Request, Anyone eligible"). The first entry is the default. Every entry satisfies
 * `joinPolicyWithinVisibility`. `group` is offered for every visibility a group room can have, so a
 * group room opened up to Friends or wider can keep camera joins to its members; pass
 * `contextType` to drop it for rooms that have no group.
 */
export function allowedJoinPoliciesFor(
  visibility: RoomVisibility,
  contextType?: RoomContextType,
): readonly RoomJoinPolicy[] {
  const policies = joinPoliciesOfferedFor(visibility)
  return contextType === undefined || contextType === 'group'
    ? policies
    : policies.filter((policy) => policy !== 'group')
}

function joinPoliciesOfferedFor(visibility: RoomVisibility): readonly RoomJoinPolicy[] {
  switch (visibility) {
    case 'invited':
      return ['invited_only', 'request']
    case 'group':
      return ['group', 'invited_only', 'request']
    case 'friends':
      return ['friends', 'group', 'request', 'invited_only']
    case 'extended':
      return [
        'friends_of_friends',
        'friends',
        'group',
        'request',
        'anyone_with_link',
        'anyone',
        'invited_only',
      ]
    case 'neighborhood':
    case 'city':
    case 'world':
      return [
        'request',
        'anyone',
        'anyone_with_link',
        'friends_of_friends',
        'friends',
        'group',
        'invited_only',
      ]
  }
}

export function isJoinPolicyAllowedFor(
  visibility: RoomVisibility,
  policy: RoomJoinPolicy,
  contextType?: RoomContextType,
): boolean {
  return allowedJoinPoliciesFor(visibility, contextType).includes(policy)
}
