import { fixtures } from '@earth/api/testing'
import {
  type NotificationDto,
  NotificationDtoSchema,
  NotificationsPageDtoSchema,
} from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  mergeNotificationPages,
  notificationDestination,
  notificationFaces,
  notificationRow,
  withNotificationRead,
} from './rows'

const SECOND_ID = '19191919-1919-4191-8191-191919191919'

function dto(overrides: Parameters<typeof fixtures.notificationDto>[0] = {}): NotificationDto {
  return NotificationDtoSchema.parse(fixtures.notificationDto(overrides))
}

describe('notification rows (SCREEN 23, spec §86)', () => {
  it('renders the exact spec copy from the payload and falls back to the server title', () => {
    expect(
      notificationRow(
        dto({ type: 'friend_live', payload: { name: 'Xavier', activity: 'Cooking dinner' } }),
      ),
    ).toMatchObject({ title: 'Xavier is live', body: 'Cooking dinner', unread: true })
    expect(
      notificationRow(
        dto({
          type: 'group_live',
          payload: { groupName: 'Weekend Crew', names: ['Xavier', 'Maya', 'A', 'B'], total: 4 },
        }),
      ),
    ).toMatchObject({ title: 'Weekend Crew is live', body: 'Xavier, Maya + 2' })
    expect(notificationRow(dto({ type: 'friend_accepted', payload: { name: 'Maya' } })).title).toBe(
      'You and Maya are friends',
    )
    expect(notificationRow(dto({ type: 'follow', payload: { name: 'Sam' } })).title).toBe(
      'Sam followed you',
    )
    expect(
      notificationRow(
        dto({
          type: 'group_message',
          payload: { groupName: 'Weekend Crew', senderName: 'Maya', preview: 'on my way' },
        }),
      ),
    ).toMatchObject({ title: 'Weekend Crew', body: 'Maya: on my way' })
    // Unusable payload: the server's rendered copy stands.
    expect(
      notificationRow(
        dto({ type: 'friend_live', title: 'Xavier is live', body: 'Tap', payload: {} }),
      ),
    ).toMatchObject({
      title: 'Xavier is live',
      body: 'Tap',
    })
  })

  it('derives faces from the names the payload carries', () => {
    expect(
      notificationFaces(
        dto({
          payload: {
            participantNames: ['Xavier', 'Maya'],
            avatarUrls: ['https://cdn.example/x.jpg'],
          },
        }),
      ),
    ).toEqual([
      { displayName: 'Xavier', avatarUrl: 'https://cdn.example/x.jpg' },
      { displayName: 'Maya', avatarUrl: null },
    ])
    expect(notificationFaces(dto({ payload: { senderName: 'Maya' } }))).toEqual([
      { displayName: 'Maya', avatarUrl: null },
    ])
    expect(notificationFaces(dto({ payload: {} }))).toEqual([])
  })

  it('routes rooms, conversations and people; marks friend requests acceptable', () => {
    expect(
      notificationDestination(dto({ objectType: 'room', objectId: fixtures.IDS.room })),
    ).toEqual({
      kind: 'room',
      roomId: fixtures.IDS.room,
    })
    expect(
      notificationDestination(
        dto({
          objectType: 'message',
          objectId: fixtures.IDS.message,
          payload: { conversationId: fixtures.IDS.conversation },
        }),
      ),
    ).toEqual({ kind: 'conversation', conversationId: fixtures.IDS.conversation })
    expect(
      notificationDestination(
        dto({
          objectType: 'human',
          objectId: fixtures.IDS.maya,
          payload: { name: 'Maya', handle: 'maya' },
        }),
      ),
    ).toEqual({
      kind: 'profile',
      handle: 'maya',
    })
    expect(
      notificationDestination(
        dto({ objectType: 'human', objectId: fixtures.IDS.maya, payload: { name: 'Maya' } }),
      ),
    ).toEqual({
      kind: 'search',
      query: 'Maya',
    })
    expect(
      notificationDestination(
        dto({ objectType: 'message', objectId: fixtures.IDS.message, payload: {} }),
      ),
    ).toEqual({ kind: 'none' })
    expect(
      notificationRow(
        dto({ type: 'friend_request', objectType: 'human', payload: { name: 'Maya' } }),
      ).acceptable,
    ).toBe(true)
    expect(
      notificationRow(
        dto({ type: 'friend_request', actorHumanId: null, payload: { name: 'Maya' } }),
      ).acceptable,
    ).toBe(false)
  })

  it('merges pages in server order and marks one read optimistically', () => {
    const first = NotificationsPageDtoSchema.parse(fixtures.notificationsPage())
    const second = NotificationsPageDtoSchema.parse(
      fixtures.notificationsPage({
        notifications: [
          fixtures.notificationDto(),
          fixtures.notificationDto({ id: SECOND_ID, type: 'follow', payload: { name: 'Sam' } }),
        ],
      }),
    )
    const merged = mergeNotificationPages([first, second])
    expect(merged).toHaveLength(2)
    const read = withNotificationRead([first], first.notifications[0]!.id, '2026-09-03T07:00:00Z')
    expect(read[0]?.notifications[0]?.readAt).toBe('2026-09-03T07:00:00Z')
    expect(read[0]?.unreadCount).toBe(2)
    expect(
      withNotificationRead(read, first.notifications[0]!.id, '2026-09-03T08:00:00Z')[0]
        ?.unreadCount,
    ).toBe(2)
  })
})
