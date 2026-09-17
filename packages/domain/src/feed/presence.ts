/**
 * SCREEN 02 presence row: "Xavier + Maya live", "Weekend Crew · 3 active", "Sarah nearby".
 *
 * The row is not ranked — `FEED_CANDIDATE_KINDS` carries only `post` and `live` — so the server
 * tier assembles it from `feed_presence()` (DB_API §4) and prepends one `PresenceCardDto` to the
 * first page. Its labels, its order and the spec's "render only when there is meaningful state,
 * never an empty placeholder" rule live here so they are stated once. `@earth/ui`'s
 * `copy.presenceLive` / `copy.presenceGroupActive` / `copy.presenceNearby` are the same strings
 * for the clients; both sides pin the spec's three examples.
 */
import type { PresenceItemType } from '../enums'
import type { PresenceCardDto, PresenceItemDto } from '../dto/feed'
import { formatNameList } from '../rooms/naming'

/** The row is one compact horizontal scroller; beyond this it stops reading as presence. */
export const PRESENCE_ITEMS_MAX = 6

/** The presence card's stable `id` — one per page, and only ever on the first page. */
export const PRESENCE_CARD_ID = 'presence'

/**
 * `Xavier + Maya live` · `Maya + 2 live` (one name known, three people). Empty string when there
 * is nobody to name, which is how a room drops out of the row.
 */
export function presenceLiveLabel(names: readonly string[], total?: number): string {
  const subject = formatNameList(names, total)
  return subject.length === 0 ? '' : `${subject} live`
}

/** `Weekend Crew · 3 active`. */
export function presenceGroupActiveLabel(groupName: string, activeCount: number): string {
  const name = groupName.trim()
  return name.length === 0 ? '' : `${name} · ${activeCount} active`
}

/** `Sarah nearby`. */
export function presenceNearbyLabel(name: string): string {
  const trimmed = name.trim()
  return trimmed.length === 0 ? '' : `${trimmed} nearby`
}

/** Row order, following the spec's own example order: live, then active groups, then nearby. */
const TYPE_RANK: Readonly<Record<PresenceItemType, number>> = {
  friends_live: 0,
  group_active: 1,
  friend_nearby: 2,
}

/**
 * The presence card for a page, or `null` when nothing meaningful is happening: SCREEN 02 renders
 * the row only with real state, so an empty (or unlabelled) item set produces no card at all
 * rather than an empty placeholder.
 */
export function presenceCard(items: readonly PresenceItemDto[]): PresenceCardDto | null {
  const labelled = items.filter((item) => item.label.trim().length > 0)
  if (labelled.length === 0) return null
  const ordered = [...labelled].sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type])
  return { kind: 'presence', id: PRESENCE_CARD_ID, items: ordered.slice(0, PRESENCE_ITEMS_MAX) }
}
