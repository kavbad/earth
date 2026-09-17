/**
 * SCREEN 02 presence row (spec PART VI SCREEN 02). The three canonical examples are pinned here
 * and, independently, against `copy.presenceLive` / `presenceGroupActive` / `presenceNearby` in
 * `packages/ui/src/copy.test.ts`; the two must not drift.
 */
import { describe, expect, it } from 'vitest'

import type { PresenceItemDto } from '../dto/feed'
import type { HumanId, RoomId } from '../ids'
import {
  PRESENCE_CARD_ID,
  PRESENCE_ITEMS_MAX,
  presenceCard,
  presenceGroupActiveLabel,
  presenceLiveLabel,
  presenceNearbyLabel,
} from './presence'

function item(overrides: Partial<PresenceItemDto> = {}): PresenceItemDto {
  return {
    type: 'friends_live',
    label: 'Xavier + Maya live',
    humanIds: [],
    roomId: null,
    conversationId: null,
    groupId: null,
    avatarUrls: [],
    ...overrides,
  }
}

describe('presence labels (SCREEN 02)', () => {
  it('renders the spec examples verbatim', () => {
    expect(presenceLiveLabel(['Xavier', 'Maya'])).toBe('Xavier + Maya live')
    expect(presenceGroupActiveLabel('Weekend Crew', 3)).toBe('Weekend Crew · 3 active')
    expect(presenceNearbyLabel('Sarah')).toBe('Sarah nearby')
  })

  it('collapses a sample into a count and empties when there is nobody to name', () => {
    expect(presenceLiveLabel(['Maya'], 3)).toBe('Maya + 2 live')
    expect(presenceLiveLabel(['Xavier', 'Maya', 'Kavon'])).toBe('Xavier, Maya + 1 live')
    expect(presenceLiveLabel([])).toBe('')
    expect(presenceLiveLabel(['  '])).toBe('')
    expect(presenceGroupActiveLabel('  ', 3)).toBe('')
    expect(presenceNearbyLabel(' ')).toBe('')
  })
})

describe('presenceCard', () => {
  it('is null with no state and drops unlabelled items (never an empty placeholder)', () => {
    expect(presenceCard([])).toBeNull()
    expect(presenceCard([item({ label: '' }), item({ label: '   ' })])).toBeNull()
  })

  it('orders live, then active groups, then nearby, keeping input order within a type', () => {
    const card = presenceCard([
      item({ type: 'friend_nearby', label: 'Sarah nearby' }),
      item({ type: 'group_active', label: 'Weekend Crew · 3 active' }),
      item({ type: 'friends_live', label: 'Xavier + Maya live' }),
      item({ type: 'group_active', label: 'College · 2 active' }),
    ])
    expect(card?.kind).toBe('presence')
    expect(card?.id).toBe(PRESENCE_CARD_ID)
    expect(card?.items.map((i) => i.label)).toEqual([
      'Xavier + Maya live',
      'Weekend Crew · 3 active',
      'College · 2 active',
      'Sarah nearby',
    ])
  })

  it('keeps the row compact', () => {
    const many = Array.from({ length: PRESENCE_ITEMS_MAX + 4 }, (_, i) =>
      item({ label: `Person ${i} nearby`, type: 'friend_nearby' }),
    )
    expect(presenceCard(many)?.items).toHaveLength(PRESENCE_ITEMS_MAX)
  })

  it('carries the ids the clients route with', () => {
    const roomId = '20000000-0000-4000-8000-000000000001' as RoomId
    const humanId = '10000000-0000-4000-8000-000000000001' as HumanId
    const card = presenceCard([item({ roomId, humanIds: [humanId] })])
    expect(card?.items[0]).toMatchObject({ roomId, humanIds: [humanId] })
  })
})
