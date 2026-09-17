/**
 * SCREEN 23 rows: spec §86 copy from the payload, faces, the destination and the expo-router
 * href a tap follows, plus optimistic read state.
 */
import { type NotificationDto, asHumanId, asNotificationId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  destinationHref,
  mergeNotificationPages,
  notificationDestination,
  notificationRow,
  withNotificationRead,
} from './notifications'

const ROOM = '77777777-7777-4777-8777-777777777777'
const CONVERSATION = '88888888-8888-4888-8888-888888888888'
const HUMAN = '11111111-1111-4111-8111-111111111111'
const NOW = '2026-09-03T06:00:00.000Z'

function dto(
  overrides: Partial<NotificationDto> & Pick<NotificationDto, 'type' | 'objectType'>,
): NotificationDto {
  return {
    id: asNotificationId('99999999-9999-4999-8999-999999999999'),
    priority: 'high',
    title: 'server title',
    body: 'server body',
    actorHumanId: null,
    objectId: HUMAN,
    payload: {},
    readAt: null,
    createdAt: NOW,
    ...overrides,
  }
}

describe('notification → route mapping', () => {
  it('a Live points at its room', () => {
    const row = notificationRow(
      dto({
        type: 'friend_live',
        objectType: 'room',
        objectId: ROOM,
        payload: { name: 'Xavier', activity: 'Cooking dinner' },
      }),
    )
    expect(row.title).toBe('Xavier is live')
    expect(row.body).toBe('Cooking dinner')
    expect(row.live).toBe(true)
    expect(row.destination).toEqual({ kind: 'room', roomId: ROOM })
    expect(destinationHref(row.destination)).toBe(`/rooms/${ROOM}`)
  })

  it('a message points at its conversation, through the payload for messages and groups', () => {
    const direct = notificationRow(
      dto({
        type: 'direct_message',
        objectType: 'conversation',
        objectId: CONVERSATION,
        payload: { senderName: 'Xavier', preview: 'hi' },
      }),
    )
    expect(destinationHref(direct.destination)).toBe(`/chats/${CONVERSATION}`)
    const group = notificationRow(
      dto({
        type: 'group_invitation',
        objectType: 'group',
        payload: { name: 'Xavier', groupName: 'Weekend Crew', conversationId: CONVERSATION },
      }),
    )
    expect(group.title).toBe('Xavier brought you into Weekend Crew')
    expect(destinationHref(group.destination)).toBe(`/chats/${CONVERSATION}`)
    expect(
      notificationDestination(dto({ type: 'group_message', objectType: 'message', payload: {} })),
    ).toEqual({ kind: 'none' })
  })

  it('a social notification opens the profile by handle, or searches the name', () => {
    const withHandle = notificationRow(
      dto({ type: 'follow', objectType: 'human', payload: { name: 'Sam', handle: 'Sam' } }),
    )
    expect(withHandle.title).toBe('Sam followed you')
    expect(destinationHref(withHandle.destination)).toBe('/u/sam')
    const nameOnly = notificationRow(
      dto({ type: 'friend_accepted', objectType: 'human', payload: { name: 'Maya' } }),
    )
    expect(nameOnly.title).toBe('You and Maya are friends')
    expect(destinationHref(nameOnly.destination)).toEqual({
      pathname: '/search',
      params: { q: 'Maya' },
    })
    expect(destinationHref({ kind: 'none' })).toBeNull()
  })

  it('a friend request is acceptable in place when the actor is known', () => {
    const actor = asHumanId(HUMAN)
    const row = notificationRow(
      dto({
        type: 'friend_request',
        objectType: 'human',
        actorHumanId: actor,
        payload: { name: 'Maya' },
      }),
    )
    expect(row.title).toBe('Maya wants to be friends')
    expect(row.acceptable).toBe(true)
    expect(row.faces).toEqual([{ displayName: 'Maya', avatarUrl: null }])
    expect(
      notificationRow(
        dto({ type: 'friend_request', objectType: 'human', payload: { name: 'Maya' } }),
      ).acceptable,
    ).toBe(false)
  })

  it('falls back to the server copy when the payload is unusable', () => {
    const row = notificationRow(dto({ type: 'friend_live', objectType: 'room', objectId: ROOM }))
    expect(row.title).toBe('server title')
    expect(row.body).toBe('server body')
  })
})

describe('pages and read state', () => {
  const a = dto({
    type: 'follow',
    objectType: 'human',
    id: asNotificationId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  })
  const b = dto({
    type: 'follow',
    objectType: 'human',
    id: asNotificationId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  })

  it('merges pages in order without duplicates', () => {
    const rows = mergeNotificationPages([
      { notifications: [a], nextCursor: 'c', unreadCount: 2 },
      { notifications: [a, b], nextCursor: null, unreadCount: 2 },
    ])
    expect(rows.map((row) => row.id)).toEqual([a.id, b.id])
  })

  it('marks one row read and lowers the unread count once', () => {
    const pages = withNotificationRead(
      [{ notifications: [a, b], nextCursor: null, unreadCount: 2 }],
      a.id,
      NOW,
    )
    expect(pages[0]?.notifications[0]?.readAt).toBe(NOW)
    expect(pages[0]?.unreadCount).toBe(1)
    expect(withNotificationRead(pages, a.id, NOW)).toEqual(pages)
  })
})
