import { describe, expect, it } from 'vitest'

import {
  UnsentNotificationsResultSchema,
  conversationIdOf,
  pushChannelFor,
  pushMessagesFor,
  pushPriorityFor,
  roomIdOf,
} from './messages'
import { createDisabledPushSender } from './noop'
import { CONVERSATION_ID, ROOM_ID, notification } from '../test/fixtures'

describe('push messages', () => {
  it('priorities: critical_social/high → high, normal/low → normal', () => {
    expect(pushPriorityFor('critical_social')).toBe('high')
    expect(pushPriorityFor('high')).toBe('high')
    expect(pushPriorityFor('normal')).toBe('normal')
    expect(pushPriorityFor('low')).toBe('normal')
  })

  it('channels per type family', () => {
    expect(pushChannelFor('group_live')).toBe('live')
    expect(pushChannelFor('group_message')).toBe('messages')
    expect(pushChannelFor('group_invitation')).toBe('social')
  })

  it('object ids: conversation from object or payload, room from object or payload', () => {
    expect(conversationIdOf(notification(1))).toBe(CONVERSATION_ID)
    expect(
      conversationIdOf(
        notification(1, { objectType: 'conversation', objectId: CONVERSATION_ID, payload: {} }),
      ),
    ).toBe(CONVERSATION_ID)
    expect(
      conversationIdOf(notification(1, { payload: { conversationId: 'nope' } })),
    ).toBeUndefined()
    expect(roomIdOf(notification(1, { objectType: 'room', objectId: ROOM_ID }))).toBe(ROOM_ID)
    expect(roomIdOf(notification(1, { payload: { roomId: ROOM_ID } }))).toBe(ROOM_ID)
    expect(roomIdOf(notification(1))).toBeUndefined()
  })

  it('renders every spec §86 copy from payloads', () => {
    const cases: [Parameters<typeof notification>[1], string, string][] = [
      [
        {
          type: 'group_message',
          payload: { groupName: 'Weekend Crew', senderName: 'Maya', preview: 'yo' },
        },
        'Weekend Crew',
        'Maya: yo',
      ],
      [
        { type: 'multi_live', payload: { names: ['Xavier', 'Maya'] } },
        'Xavier + Maya are live',
        'Join them',
      ],
      [
        {
          type: 'group_live',
          payload: { groupName: 'Weekend Crew', names: ['Xavier', 'Maya'], total: 4 },
        },
        'Weekend Crew is live',
        'Xavier, Maya + 2',
      ],
      [{ type: 'friend_accepted', payload: { name: 'Maya' } }, 'You and Maya are friends', ''],
      [
        { type: 'group_invitation', payload: { name: 'Xavier', groupName: 'Weekend Crew' } },
        'Xavier brought you into Weekend Crew',
        '',
      ],
    ]
    for (const [overrides, title, body] of cases) {
      const messages = pushMessagesFor(notification(1, overrides))
      expect(messages?.[0]).toMatchObject({ title, body })
    }
    expect(pushMessagesFor(notification(1, { type: 'follow', payload: {} }))).toBeNull()
  })

  it('accepts array, wrapped and null results', () => {
    expect(UnsentNotificationsResultSchema.parse(null)).toEqual([])
    expect(
      UnsentNotificationsResultSchema.parse({ notifications: [notification(1)] }),
    ).toHaveLength(1)
    expect(UnsentNotificationsResultSchema.parse([notification(1)])[0]?.presence).toBeNull()
  })

  it('the disabled sender refuses every message non-transiently', async () => {
    const tickets = await createDisabledPushSender().send([
      { to: 'x', title: 't', body: 'b', data: {}, priority: 'high' },
    ])
    expect(tickets).toEqual([
      {
        status: 'error',
        message: 'push delivery is disabled',
        details: { error: 'ProviderError' },
        transient: false,
      },
    ])
  })
})

describe('adversarial: one message per distinct device', () => {
  it('drops duplicate tokens of the same notification', () => {
    const messages = pushMessagesFor(
      notification(1, {
        pushTokens: [
          { token: 'ExponentPushToken[a]', platform: 'ios' },
          { token: 'ExponentPushToken[a]', platform: 'android' },
          { token: 'ExponentPushToken[b]', platform: 'ios' },
        ],
      }),
    )
    expect(messages?.map((m) => m.to)).toEqual(['ExponentPushToken[a]', 'ExponentPushToken[b]'])
  })
})
