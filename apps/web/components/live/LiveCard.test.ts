import type { LiveCardDto, RoomId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { cardContextLine, cardFaces } from './LiveCard'

const ROOM = '55555555-5555-4555-8555-555555555555' as RoomId

function card(overrides: Partial<LiveCardDto> = {}): LiveCardDto {
  return {
    kind: 'live',
    id: ROOM,
    roomId: ROOM,
    title: 'Xavier + Kavon are live',
    participantNames: ['Xavier', 'Kavon'],
    participantAvatars: ['https://cdn.example/x.jpg', null],
    participantCount: 2,
    visibility: 'friends',
    contextTitle: null,
    startedAt: '2026-09-03T10:00:00.000Z',
    areaName: 'North Beach',
    ...overrides,
  }
}

describe('LiveCard (SCREEN 13)', () => {
  it('pairs names with avatars, tolerating a shorter avatar list', () => {
    expect(cardFaces(card({ participantAvatars: ['https://cdn.example/x.jpg'] }))).toEqual([
      { displayName: 'Xavier', avatarUrl: 'https://cdn.example/x.jpg' },
      { displayName: 'Kavon', avatarUrl: null },
    ])
  })

  it('shows the area only for public Lives and the context only when the title does not', () => {
    expect(cardContextLine(card())).toBe('')
    expect(cardContextLine(card({ visibility: 'city' }))).toBe('North Beach')
    expect(cardContextLine(card({ title: 'Weekend Crew is live', contextTitle: 'Weekend Crew', visibility: 'world' }))).toBe(
      'North Beach',
    )
    expect(cardContextLine(card({ contextTitle: 'Weekend Crew', visibility: 'neighborhood' }))).toBe(
      'Weekend Crew · North Beach',
    )
    expect(cardContextLine(card({ contextTitle: 'Weekend Crew', visibility: 'group', areaName: null }))).toBe('Weekend Crew')
  })
})
