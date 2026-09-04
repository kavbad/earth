/**
 * Participant-aware naming (spec §59, §60, §86; ARCHITECTURE §1 rule-home table and §9).
 *
 * A Live is a Room whose participants are named *for the viewer*: two viewers of the same room
 * may see a different order ("Xavier + Kavon are live" vs "Kavon + Xavier are live") while the
 * room identity stays stable. This module is pure and is shared by the server tier (feed / live
 * cards, notification copy) and by clients (room headers). It must never depend on `@earth/ui`;
 * the ui copy builders may delegate to it.
 *
 * Privacy rule: only *publishing* participants (`audio` / `camera`) are nameable and counted.
 * Viewers (`watching`) never appear in a title or in the "+ N" count — joining as a viewer must
 * not reveal presence to anyone (SCREEN 16: "If you join on camera, people on Earth may see that
 * you're here").
 */
import type {
  MediaState,
  NotificationType,
  ParticipantStatus,
  RoomContextType,
  ViewerRelation,
} from '../enums'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The subset of `RoomParticipantDto` naming needs. `relation` is `null` for visitors/guests. */
export interface NamingParticipant {
  readonly id: string
  readonly displayName: string
  readonly isGuest: boolean
  readonly mediaState: MediaState
  readonly status: ParticipantStatus
  readonly relation: ViewerRelation | null
  readonly joinedAt: string | number | Date
}

/** Viewer-specific relation overrides keyed by participant `id` (ARCHITECTURE §9 signature). */
export type ViewerRelations = Readonly<Record<string, ViewerRelation>>

export interface OrderParticipantsOptions {
  /** Keep the viewer's own participant row (sorted first). Default `false`: self is never named. */
  readonly includeSelf?: boolean
  /** Keep `watching` participants (sorted after publishers). Default `false`. */
  readonly includeWatching?: boolean
}

/** How a room is titled. `event` / `place` contexts are titled like standalone rooms in V1. */
export const ROOM_TITLE_KINDS = ['group', 'direct', 'standalone'] as const
export type RoomTitleKind = (typeof ROOM_TITLE_KINDS)[number]

export interface RoomTitleInput {
  readonly kind: RoomTitleKind
  /** "Weekend Crew" for group rooms; `null` for unnamed groups and non-group rooms. */
  readonly contextTitle: string | null
  readonly participants: readonly NamingParticipant[]
  readonly viewerRelations?: ViewerRelations
  /** Optional activity label ("Cooking dinner"); used as the friend Live body / subtitle. */
  readonly activityTitle?: string | null
  /** Maximum participants picked for naming (names/avatars). Default `NAMED_PARTICIPANTS_MAX`. */
  readonly maxNames?: number
}

export interface RoomTitle {
  readonly title: string
  readonly subtitle: string | null
  /** Display names of the picked participants, most relevant first (for avatars/labels). */
  readonly names: readonly string[]
  /** Number of nameable participants (active publishers, excluding the viewer). */
  readonly total: number
}

export interface LiveNotificationCopy {
  readonly type: Extract<NotificationType, 'friend_live' | 'multi_live' | 'group_live'>
  readonly title: string
  readonly body: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Spec §60: the card selects the most relevant 1–3 visible Humans. */
export const NAMED_PARTICIPANTS_MAX = 3
/** Names spelled out before collapsing into a count: `Xavier, Maya + 2` (spec §86). */
export const SPELLED_NAMES_MAX = 2
/** Title of a room nobody is publishing in yet. */
export const EMPTY_ROOM_TITLE = 'Live'
/** Spec §86 body for multi-person Lives and for friend Lives without an activity. */
export const LIVE_JOIN_PROMPT = 'Join them'

const RELATION_RANK: Readonly<Record<ViewerRelation, number>> = {
  self: -1,
  friend: 0,
  shared_group: 1,
  familiar: 2,
  other: 3,
}
/** Guests sort after every Human, whatever their relation (they have no social graph). */
const GUEST_RANK = 4

const MEDIA_RANK: Readonly<Record<MediaState, number>> = {
  camera: 0,
  audio: 1,
  watching: 2,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toMs(value: string | number | Date): number {
  const ms =
    value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value)
  // Unknown join time sorts last.
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function cleanTitle(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

export function roomTitleKindFor(contextType: RoomContextType): RoomTitleKind {
  switch (contextType) {
    case 'group':
      return 'group'
    case 'direct':
      return 'direct'
    case 'standalone':
    case 'event':
    case 'place':
      return 'standalone'
  }
}

/** The relation used for ordering: override → participant's own → `other`. */
export function relationForViewer(
  participant: Pick<NamingParticipant, 'id' | 'relation'>,
  viewerRelations?: ViewerRelations,
): ViewerRelation {
  return viewerRelations?.[participant.id] ?? participant.relation ?? 'other'
}

/**
 * Sorts active participants by social relevance for the viewer (spec §60):
 * friend > shared_group > familiar > other, then camera > audio > watching, then `joinedAt`
 * ascending, then `id` for determinism. Guests always sort last. Self and viewers are excluded
 * unless the options say otherwise.
 */
export function orderParticipantsForViewer<T extends NamingParticipant>(
  participants: readonly T[],
  viewerRelations?: ViewerRelations,
  options: OrderParticipantsOptions = {},
): T[] {
  const includeSelf = options.includeSelf === true
  const includeWatching = options.includeWatching === true

  const keyed = participants
    .filter((p) => p.status === 'active')
    .map((p) => ({ p, relation: relationForViewer(p, viewerRelations) }))
    .filter(
      ({ p, relation }) =>
        (includeSelf || relation !== 'self') && (includeWatching || p.mediaState !== 'watching'),
    )

  keyed.sort((a, b) => {
    const rankA =
      a.relation === 'self'
        ? RELATION_RANK.self
        : a.p.isGuest
          ? GUEST_RANK
          : RELATION_RANK[a.relation]
    const rankB =
      b.relation === 'self'
        ? RELATION_RANK.self
        : b.p.isGuest
          ? GUEST_RANK
          : RELATION_RANK[b.relation]
    if (rankA !== rankB) return rankA - rankB
    const mediaDiff = MEDIA_RANK[a.p.mediaState] - MEDIA_RANK[b.p.mediaState]
    if (mediaDiff !== 0) return mediaDiff
    const joinedA = toMs(a.p.joinedAt)
    const joinedB = toMs(b.p.joinedAt)
    if (joinedA !== joinedB) return joinedA < joinedB ? -1 : 1
    return compareStrings(a.p.id, b.p.id)
  })

  return keyed.map((k) => k.p)
}

/** The most relevant `max` participants of an already ordered list. */
export function pickNamedParticipants<T extends NamingParticipant>(
  sorted: readonly T[],
  max: number = NAMED_PARTICIPANTS_MAX,
): T[] {
  return sorted.slice(0, Math.max(0, Math.floor(max)))
}

/**
 * Name list in the Live / room style (spec §59, §86, SCREEN 08/14):
 * `Xavier` · `Xavier + Kavon` · `Xavier, Maya + 2` · `Maya + 2` (one name known, three people).
 * At most `maxSpelled` names are spelled out; the remainder is a bare count. `total` is the number
 * of people when `names` is only a sample (defaults to `names.length`).
 */
export function formatNameList(
  names: readonly string[],
  total?: number,
  maxSpelled: number = SPELLED_NAMES_MAX,
): string {
  const clean = names.map((n) => n.trim()).filter((n) => n.length > 0)
  const shown = clean.slice(0, Math.max(0, maxSpelled))
  const count = Math.max(total ?? clean.length, shown.length)
  const rest = count - shown.length
  if (shown.length === 0) return rest > 0 ? (rest === 1 ? '1 person' : `${rest} people`) : ''
  if (rest > 0) return `${shown.join(', ')} + ${rest}`
  if (shown.length === 1) return shown[0] ?? ''
  const last = shown[shown.length - 1] ?? ''
  return `${shown.slice(0, -1).join(', ')} + ${last}`
}

/**
 * `Xavier is live` · `Xavier + Kavon are live` · `Xavier, Maya + 2 are live`.
 * Empty string when nobody is live.
 */
export function liveTitle(names: readonly string[], total?: number): string {
  const subject = formatNameList(names, total)
  if (subject.length === 0) return ''
  const count = Math.max(total ?? names.length, names.filter((n) => n.trim().length > 0).length)
  return count === 1 ? `${subject} is live` : `${subject} are live`
}

/** `Weekend Crew is live` (ARCHITECTURE §9, spec §86 group Live title). */
export function groupLiveTitle(groupName: string): string {
  return `${groupName} is live`
}

interface NamedRoom {
  readonly names: string[]
  readonly total: number
  readonly context: string | null
  readonly activity: string | null
}

function nameRoom(input: RoomTitleInput): NamedRoom {
  const ordered = orderParticipantsForViewer(input.participants, input.viewerRelations)
  const named = pickNamedParticipants(ordered, input.maxNames ?? NAMED_PARTICIPANTS_MAX)
  const names = named.map((p) => p.displayName.trim()).filter((n) => n.length > 0)
  return {
    names,
    total: ordered.length,
    context: cleanTitle(input.contextTitle),
    activity: cleanTitle(input.activityTitle),
  }
}

/**
 * Title + subtitle of a room for the viewer.
 * - Group rooms: title `Weekend Crew`, subtitle `Xavier, Maya + 2`.
 * - Everything else (direct, standalone, unnamed group): title `Xavier is live` /
 *   `Xavier + Kavon are live` / `Xavier, Maya + 2 are live`, subtitle the activity if any.
 */
export function roomTitle(input: RoomTitleInput): RoomTitle {
  const { names, total, context, activity } = nameRoom(input)
  if (input.kind === 'group' && context !== null) {
    return {
      title: context,
      subtitle: total > 0 ? formatNameList(names, total) : activity,
      names,
      total,
    }
  }
  if (total === 0) {
    return { title: context ?? EMPTY_ROOM_TITLE, subtitle: activity, names, total }
  }
  return { title: liveTitle(names, total), subtitle: activity, names, total }
}

/**
 * SCREEN 14 top label: the room context — `Weekend Crew` or `Xavier + Kavon` (no "are live").
 */
export function roomHeaderTitle(input: RoomTitleInput): string {
  const { names, total, context } = nameRoom(input)
  if (context !== null) return context
  return total > 0 ? formatNameList(names, total) : EMPTY_ROOM_TITLE
}

/**
 * Live discovery / feed card title (ARCHITECTURE §9): `Xavier is live`, `Xavier + Kavon are live`,
 * `Weekend Crew is live`.
 */
export function liveCardTitle(input: RoomTitleInput): string {
  const { names, total, context } = nameRoom(input)
  if (input.kind === 'group' && context !== null) return groupLiveTitle(context)
  if (total === 0) return context ?? EMPTY_ROOM_TITLE
  return liveTitle(names, total)
}

/**
 * Notification type + copy for a Live, exactly per spec §86:
 * - Friend Live — `Xavier is live` + `Cooking dinner` (or `Join them` without an activity)
 * - Multi-person Live — `Xavier + Maya are live` + `Join them`
 * - Group Live — `Weekend Crew is live` + `Xavier, Maya + 2`
 * Returns `null` when nobody is publishing (nothing to announce).
 */
export function liveNotificationCopy(input: RoomTitleInput): LiveNotificationCopy | null {
  const { names, total, context, activity } = nameRoom(input)
  if (total === 0) return null
  if (input.kind === 'group' && context !== null) {
    return {
      type: 'group_live',
      title: groupLiveTitle(context),
      body: names.length > 0 ? formatNameList(names, total) : LIVE_JOIN_PROMPT,
    }
  }
  if (total === 1) {
    return {
      type: 'friend_live',
      title: liveTitle(names, total),
      body: activity ?? LIVE_JOIN_PROMPT,
    }
  }
  return { type: 'multi_live', title: liveTitle(names, total), body: LIVE_JOIN_PROMPT }
}
