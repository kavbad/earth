import type { LiveCardDto, RoomId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { LIVE_ROW_HEIGHT, cardContextLine, cardFaces, markImpression } from './live'

const ROOM = '11111111-1111-4111-8111-111111111111' as RoomId

function card(overrides: Partial<LiveCardDto> = {}): LiveCardDto {
  return {
    kind: 'live',
    id: ROOM,
    roomId: ROOM,
    title: 'Xavier + Kavon are live',
    participantNames: ['Xavier', 'Kavon'],
    participantAvatars: ['https://cdn.example/x.png', null],
    participantCount: 2,
    visibility: 'friends',
    contextTitle: null,
    startedAt: '2026-09-03T10:00:00.000Z',
    areaName: 'Mission',
    ...overrides,
  }
}

describe('cardFaces', () => {
  it('pairs names with avatars, missing avatars read as null', () => {
    expect(cardFaces(card())).toEqual([
      { displayName: 'Xavier', avatarUrl: 'https://cdn.example/x.png' },
      { displayName: 'Kavon', avatarUrl: null },
    ])
  })
})

describe('cardContextLine (SCREEN 13 second line)', () => {
  it('adds the context when the title does not already name it', () => {
    expect(cardContextLine(card({ contextTitle: 'Weekend Crew' }))).toBe('Weekend Crew')
    expect(
      cardContextLine(card({ title: 'Weekend Crew is live', contextTitle: 'Weekend Crew' })),
    ).toBe('')
  })

  it('shows the area only for public Lives', () => {
    expect(cardContextLine(card({ visibility: 'friends' }))).toBe('')
    expect(cardContextLine(card({ visibility: 'city' }))).toBe('Mission')
    expect(cardContextLine(card({ visibility: 'city', contextTitle: 'Weekend Crew' }))).toBe(
      'Weekend Crew · Mission',
    )
    expect(cardContextLine(card({ visibility: 'group', areaName: 'Mission' }))).toBe('')
  })
})

describe('markImpression', () => {
  it('reports each card once per scope', () => {
    const seen = new Set<string>()
    expect(markImpression(seen, 'friends', ROOM)).toBe(true)
    expect(markImpression(seen, 'friends', ROOM)).toBe(false)
    expect(markImpression(seen, 'world', ROOM)).toBe(true)
  })
})

describe('LIVE_ROW_HEIGHT', () => {
  it('sits on the 8pt baseline', () => {
    expect(LIVE_ROW_HEIGHT % 8).toBe(0)
  })
})
