/**
 * Live Home (SCREEN 13) card helpers: faces, the second line, impression bookkeeping and the fixed
 * row geometry the list needs for `getItemLayout`. Pure.
 */
import {
  type LiveCardDto,
  type RoomId,
  type Scope,
  discoveryScopeForVisibility,
} from '@earth/domain'
import { avatarSize, space } from '@earth/ui'

export interface CardFace {
  readonly displayName: string
  readonly avatarUrl: string | null
}

export function cardFaces(card: LiveCardDto): CardFace[] {
  return card.participantNames.map((displayName, index) => ({
    displayName,
    avatarUrl: card.participantAvatars[index] ?? null,
  }))
}

/** The second line: the context when the title already names people, the area for public Lives. */
export function cardContextLine(card: LiveCardDto): string {
  const parts: string[] = []
  if (card.contextTitle !== null && !card.title.startsWith(card.contextTitle)) {
    parts.push(card.contextTitle)
  }
  const scope = discoveryScopeForVisibility(card.visibility)
  if (card.areaName !== null && scope !== null && scope !== 'friends') parts.push(card.areaName)
  return parts.join(' · ')
}

/** Row: 12 vertical padding around a 40pt face stack — a fixed height so the list can jump. */
export const LIVE_ROW_HEIGHT = avatarSize.medium + space[3] * 2

/** Half the card visible counts as seen (spec §97 `live_card_impression`), reported once. */
export const IMPRESSION_THRESHOLD_PERCENT = 50

export function impressionKey(scope: Scope, roomId: RoomId): string {
  return `${scope}:${roomId}`
}

/**
 * Records an impression; `true` the first time a card is seen in a scope, `false` after. The set
 * is per screen visit so re-opening the tab counts again.
 */
export function markImpression(seen: Set<string>, scope: Scope, roomId: RoomId): boolean {
  const key = impressionKey(scope, roomId)
  if (seen.has(key)) return false
  seen.add(key)
  return true
}
