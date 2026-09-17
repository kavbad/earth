import { describe, expect, it } from 'vitest'

import type { MediaState, ParticipantStatus, ViewerRelation } from '../enums'
import {
  EMPTY_ROOM_TITLE,
  formatNameList,
  groupLiveTitle,
  liveCardTitle,
  liveNotificationCopy,
  liveTitle,
  NAMED_PARTICIPANTS_MAX,
  type NamingParticipant,
  orderParticipantsForViewer,
  pickNamedParticipants,
  roomHeaderTitle,
  roomTitle,
  roomTitleKindFor,
  SPELLED_NAMES_MAX,
} from './naming'

interface Overrides {
  readonly isGuest?: boolean
  readonly mediaState?: MediaState
  readonly status?: ParticipantStatus
  readonly relation?: ViewerRelation | null
  readonly joinedAt?: string
}

let joinCounter = 0
function participant(
  id: string,
  displayName: string,
  overrides: Overrides = {},
): NamingParticipant {
  joinCounter += 1
  return {
    id,
    displayName,
    isGuest: overrides.isGuest ?? false,
    mediaState: overrides.mediaState ?? 'camera',
    status: overrides.status ?? 'active',
    relation: overrides.relation === undefined ? 'other' : overrides.relation,
    joinedAt:
      overrides.joinedAt ?? new Date(Date.UTC(2026, 8, 3, 12, 0, joinCounter)).toISOString(),
  }
}

const ids = (list: readonly NamingParticipant[]): string[] => list.map((p) => p.id)

describe('orderParticipantsForViewer (spec §60)', () => {
  it('keeps only active publishers and excludes self', () => {
    const list = [
      participant('me', 'Me', { relation: 'self' }),
      participant('x', 'Xavier', { relation: 'friend' }),
      participant('left', 'Left', { relation: 'friend', status: 'left' }),
      participant('invited', 'Invited', { relation: 'friend', status: 'invited' }),
      participant('w', 'Watcher', { relation: 'friend', mediaState: 'watching' }),
    ]
    expect(ids(orderParticipantsForViewer(list))).toEqual(['x'])
    expect(ids(orderParticipantsForViewer(list, undefined, { includeSelf: true }))).toEqual([
      'me',
      'x',
    ])
    expect(ids(orderParticipantsForViewer(list, undefined, { includeWatching: true }))).toEqual([
      'x',
      'w',
    ])
  })

  it('orders friend > shared_group > familiar > other, guests last', () => {
    const list = [
      participant('o', 'Other', { relation: 'other' }),
      participant('g', 'Guest', { isGuest: true, relation: null }),
      participant('f', 'Familiar', { relation: 'familiar' }),
      participant('s', 'Shared', { relation: 'shared_group' }),
      participant('fr', 'Friend', { relation: 'friend' }),
      participant('n', 'NullRelation', { relation: null }),
    ]
    expect(ids(orderParticipantsForViewer(list))).toEqual(['fr', 's', 'f', 'o', 'n', 'g'])
  })

  it('within a relation orders camera > audio, then joinedAt ascending, then id', () => {
    const list = [
      participant('late-cam', 'A', { relation: 'friend', joinedAt: '2026-09-03T12:00:10Z' }),
      participant('audio', 'B', {
        relation: 'friend',
        mediaState: 'audio',
        joinedAt: '2026-09-03T12:00:00Z',
      }),
      participant('early-cam', 'C', { relation: 'friend', joinedAt: '2026-09-03T12:00:05Z' }),
      participant('b-same', 'D', { relation: 'friend', joinedAt: '2026-09-03T12:00:10Z' }),
      participant('a-same', 'E', { relation: 'friend', joinedAt: '2026-09-03T12:00:10Z' }),
    ]
    expect(ids(orderParticipantsForViewer(list))).toEqual([
      'early-cam',
      'a-same',
      'b-same',
      'late-cam',
      'audio',
    ])
  })

  it('applies viewer relation overrides keyed by participant id', () => {
    const list = [
      participant('x', 'Xavier', { relation: 'other' }),
      participant('m', 'Maya', { relation: 'friend' }),
    ]
    expect(ids(orderParticipantsForViewer(list))).toEqual(['m', 'x'])
    expect(ids(orderParticipantsForViewer(list, { x: 'friend', m: 'other' }))).toEqual(['x', 'm'])
  })

  it('does not mutate the input', () => {
    const list = [participant('a', 'A'), participant('b', 'B', { relation: 'friend' })]
    const copy = [...list]
    orderParticipantsForViewer(list)
    expect(list).toEqual(copy)
  })
})

describe('pickNamedParticipants', () => {
  it('takes the most relevant 1–3 by default', () => {
    const sorted = ['a', 'b', 'c', 'd'].map((id) => participant(id, id.toUpperCase()))
    expect(NAMED_PARTICIPANTS_MAX).toBe(3)
    expect(ids(pickNamedParticipants(sorted))).toEqual(['a', 'b', 'c'])
    expect(ids(pickNamedParticipants(sorted, 1))).toEqual(['a'])
    expect(ids(pickNamedParticipants(sorted, 0))).toEqual([])
    expect(ids(pickNamedParticipants(sorted, -2))).toEqual([])
  })
})

describe('formatNameList / liveTitle (spec §59, §86)', () => {
  it('spells out at most two names then a count', () => {
    expect(SPELLED_NAMES_MAX).toBe(2)
    expect(formatNameList([])).toBe('')
    expect(formatNameList(['Xavier'])).toBe('Xavier')
    expect(formatNameList(['Xavier', 'Kavon'])).toBe('Xavier + Kavon')
    expect(formatNameList(['Xavier', 'Maya', 'Sam'])).toBe('Xavier, Maya + 1')
    expect(formatNameList(['Xavier', 'Maya', 'Sam', 'Ben'])).toBe('Xavier, Maya + 2')
    expect(formatNameList(['Maya'], 3)).toBe('Maya + 2')
    expect(formatNameList([], 3)).toBe('3 people')
    expect(formatNameList([], 1)).toBe('1 person')
    expect(formatNameList(['  ', 'Xavier', ''], 2)).toBe('Xavier + 1')
    expect(formatNameList(['A', 'B', 'C'], undefined, 3)).toBe('A, B + C')
  })

  it('composes live titles', () => {
    expect(liveTitle(['Xavier'])).toBe('Xavier is live')
    expect(liveTitle(['Xavier', 'Kavon'])).toBe('Xavier + Kavon are live')
    expect(liveTitle(['Xavier', 'Maya', 'Sam', 'Ben'])).toBe('Xavier, Maya + 2 are live')
    expect(liveTitle(['Xavier'], 3)).toBe('Xavier + 2 are live')
    expect(liveTitle([])).toBe('')
    expect(groupLiveTitle('Weekend Crew')).toBe('Weekend Crew is live')
  })
})

describe('roomTitle / liveCardTitle / roomHeaderTitle', () => {
  const crew = [
    participant('x', 'Xavier', { relation: 'friend' }),
    participant('m', 'Maya', { relation: 'shared_group' }),
    participant('s', 'Sam'),
    participant('b', 'Ben'),
  ]

  it('group rooms: context title with participant subtitle', () => {
    const title = roomTitle({ kind: 'group', contextTitle: 'Weekend Crew', participants: crew })
    expect(title).toEqual({
      title: 'Weekend Crew',
      subtitle: 'Xavier, Maya + 2',
      names: ['Xavier', 'Maya', 'Sam'],
      total: 4,
    })
    expect(liveCardTitle({ kind: 'group', contextTitle: 'Weekend Crew', participants: crew })).toBe(
      'Weekend Crew is live',
    )
    expect(
      roomHeaderTitle({ kind: 'group', contextTitle: 'Weekend Crew', participants: crew }),
    ).toBe('Weekend Crew')
  })

  it('unnamed group rooms fall back to participant naming', () => {
    const title = roomTitle({ kind: 'group', contextTitle: null, participants: crew })
    expect(title.title).toBe('Xavier, Maya + 2 are live')
    expect(title.subtitle).toBeNull()
    expect(roomHeaderTitle({ kind: 'group', contextTitle: '  ', participants: crew })).toBe(
      'Xavier, Maya + 2',
    )
  })

  it('non-group rooms: "X is live" / "X + Y are live" / "X, Y + 2 are live"', () => {
    const [x, k] = [participant('x', 'Xavier', { relation: 'friend' }), participant('k', 'Kavon')]
    expect(roomTitle({ kind: 'standalone', contextTitle: null, participants: [x] }).title).toBe(
      'Xavier is live',
    )
    expect(roomTitle({ kind: 'direct', contextTitle: null, participants: [x, k] }).title).toBe(
      'Xavier + Kavon are live',
    )
    expect(roomTitle({ kind: 'standalone', contextTitle: null, participants: crew }).title).toBe(
      'Xavier, Maya + 2 are live',
    )
    expect(
      liveCardTitle({ kind: 'direct', contextTitle: 'Xavier + Kavon', participants: [x, k] }),
    ).toBe('Xavier + Kavon are live')
    expect(roomHeaderTitle({ kind: 'direct', contextTitle: null, participants: [x, k] })).toBe(
      'Xavier + Kavon',
    )
  })

  it('carries the activity as subtitle for non-group rooms', () => {
    const x = participant('x', 'Xavier', { relation: 'friend' })
    const title = roomTitle({
      kind: 'standalone',
      contextTitle: null,
      participants: [x],
      activityTitle: 'Cooking dinner',
    })
    expect(title).toEqual({
      title: 'Xavier is live',
      subtitle: 'Cooking dinner',
      names: ['Xavier'],
      total: 1,
    })
  })

  it('rooms with nobody publishing', () => {
    const watcher = participant('w', 'Watcher', { relation: 'friend', mediaState: 'watching' })
    expect(roomTitle({ kind: 'standalone', contextTitle: null, participants: [watcher] })).toEqual({
      title: EMPTY_ROOM_TITLE,
      subtitle: null,
      names: [],
      total: 0,
    })
    expect(
      roomTitle({ kind: 'group', contextTitle: 'Weekend Crew', participants: [] }).subtitle,
    ).toBeNull()
    expect(liveCardTitle({ kind: 'direct', contextTitle: null, participants: [] })).toBe(
      EMPTY_ROOM_TITLE,
    )
  })

  it('never names the viewer or viewers (watching)', () => {
    const list = [
      participant('me', 'Me', { relation: 'self' }),
      participant('w', 'Watching Friend', { relation: 'friend', mediaState: 'watching' }),
      participant('x', 'Xavier'),
    ]
    expect(roomTitle({ kind: 'standalone', contextTitle: null, participants: list })).toMatchObject(
      {
        title: 'Xavier is live',
        total: 1,
      },
    )
  })

  it('two viewers of the same room get different titles, same room identity', () => {
    const room = [
      participant('x', 'Xavier', { joinedAt: '2026-09-03T12:00:00Z' }),
      participant('m', 'Maya', { joinedAt: '2026-09-03T12:00:01Z' }),
      participant('s', 'Sam', { joinedAt: '2026-09-03T12:00:02Z' }),
      participant('b', 'Ben', { joinedAt: '2026-09-03T12:00:03Z' }),
    ]
    const forA = roomTitle({
      kind: 'standalone',
      contextTitle: null,
      participants: room,
      viewerRelations: { x: 'friend' },
    })
    const forB = roomTitle({
      kind: 'standalone',
      contextTitle: null,
      participants: room,
      viewerRelations: { m: 'friend' },
    })
    expect(forA.title).toBe('Xavier, Maya + 2 are live')
    expect(forB.title).toBe('Maya, Xavier + 2 are live')
    expect(forA.title).not.toBe(forB.title)
    expect(forA.total).toBe(forB.total)
    expect([...forA.names].sort()).toEqual([...forB.names].sort())
  })

  it('maps room context types onto title kinds', () => {
    expect(roomTitleKindFor('group')).toBe('group')
    expect(roomTitleKindFor('direct')).toBe('direct')
    expect(roomTitleKindFor('standalone')).toBe('standalone')
    expect(roomTitleKindFor('event')).toBe('standalone')
    expect(roomTitleKindFor('place')).toBe('standalone')
  })
})

describe('liveNotificationCopy (spec §86)', () => {
  const x = participant('x', 'Xavier', { relation: 'friend' })
  const m = participant('m', 'Maya')

  it('friend Live: "Xavier is live" + activity or "Join them"', () => {
    expect(
      liveNotificationCopy({
        kind: 'standalone',
        contextTitle: null,
        participants: [x],
        activityTitle: 'Cooking dinner',
      }),
    ).toEqual({
      type: 'friend_live',
      title: 'Xavier is live',
      body: 'Cooking dinner',
    })
    expect(
      liveNotificationCopy({ kind: 'standalone', contextTitle: null, participants: [x] }),
    ).toEqual({
      type: 'friend_live',
      title: 'Xavier is live',
      body: 'Join them',
    })
  })

  it('multi-person Live: "Xavier + Maya are live" + "Join them"', () => {
    expect(
      liveNotificationCopy({ kind: 'direct', contextTitle: null, participants: [x, m] }),
    ).toEqual({
      type: 'multi_live',
      title: 'Xavier + Maya are live',
      body: 'Join them',
    })
  })

  it('group Live: "Weekend Crew is live" + "Xavier, Maya + 2"', () => {
    const crew = [x, m, participant('s', 'Sam'), participant('b', 'Ben')]
    expect(
      liveNotificationCopy({ kind: 'group', contextTitle: 'Weekend Crew', participants: crew }),
    ).toEqual({
      type: 'group_live',
      title: 'Weekend Crew is live',
      body: 'Xavier, Maya + 2',
    })
  })

  it('nothing to announce when nobody publishes', () => {
    expect(
      liveNotificationCopy({ kind: 'group', contextTitle: 'Weekend Crew', participants: [] }),
    ).toBeNull()
    expect(
      liveNotificationCopy({
        kind: 'standalone',
        contextTitle: null,
        participants: [participant('w', 'W', { mediaState: 'watching' })],
      }),
    ).toBeNull()
  })
})
