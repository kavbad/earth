import { describe, expect, it } from 'vitest'

import { NOTIFICATION_TYPES, type NotificationType } from '../enums'
import { liveNotificationCopy, type NamingParticipant } from '../rooms/naming'
import {
  NOTIFICATION_PAYLOAD_SCHEMAS,
  notificationCopy,
  notificationCopyFromPayload,
  notificationCopyInputFromPayload,
} from './copy'

describe('notificationCopy (spec §86, exact strings)', () => {
  it('direct message: "Xavier" + preview', () => {
    expect(
      notificationCopy({ type: 'direct_message', senderName: 'Xavier', preview: 'see you at 8?' }),
    ).toEqual({ title: 'Xavier', body: 'see you at 8?' })
  })

  it('group message: "Weekend Crew" + "Maya: preview"', () => {
    expect(
      notificationCopy({
        type: 'group_message',
        groupName: 'Weekend Crew',
        senderName: 'Maya',
        preview: 'bringing snacks',
      }),
    ).toEqual({ title: 'Weekend Crew', body: 'Maya: bringing snacks' })
  })

  it('friend Live: "Xavier is live" + "Cooking dinner" (or "Join them")', () => {
    expect(
      notificationCopy({ type: 'friend_live', name: 'Xavier', activity: 'Cooking dinner' }),
    ).toEqual({ title: 'Xavier is live', body: 'Cooking dinner' })
    expect(notificationCopy({ type: 'friend_live', name: 'Xavier' })).toEqual({
      title: 'Xavier is live',
      body: 'Join them',
    })
    expect(notificationCopy({ type: 'friend_live', name: 'Xavier', activity: null }).body).toBe(
      'Join them',
    )
    expect(notificationCopy({ type: 'friend_live', name: 'Xavier', activity: '  ' }).body).toBe(
      'Join them',
    )
  })

  it('multi-person Live: "Xavier + Maya are live" + "Join them"', () => {
    expect(notificationCopy({ type: 'multi_live', names: ['Xavier', 'Maya'] })).toEqual({
      title: 'Xavier + Maya are live',
      body: 'Join them',
    })
    expect(
      notificationCopy({ type: 'multi_live', names: ['Xavier', 'Maya', 'Sam', 'Ben'] }).title,
    ).toBe('Xavier, Maya + 2 are live')
    expect(notificationCopy({ type: 'multi_live', names: ['Xavier'], total: 3 }).title).toBe(
      'Xavier + 2 are live',
    )
    expect(notificationCopy({ type: 'multi_live', names: ['Xavier'] }).title).toBe(
      'Xavier + 1 are live',
    )
  })

  it('group Live: "Weekend Crew is live" + "Xavier, Maya + 2"', () => {
    expect(
      notificationCopy({
        type: 'group_live',
        groupName: 'Weekend Crew',
        names: ['Xavier', 'Maya', 'Sam', 'Ben'],
      }),
    ).toEqual({ title: 'Weekend Crew is live', body: 'Xavier, Maya + 2' })
    expect(
      notificationCopy({
        type: 'group_live',
        groupName: 'Weekend Crew',
        names: ['Xavier', 'Maya'],
        total: 4,
      }).body,
    ).toBe('Xavier, Maya + 2')
  })

  it('friend request / accepted / follow / group invitation', () => {
    expect(notificationCopy({ type: 'friend_request', name: 'Maya' })).toEqual({
      title: 'Maya wants to be friends',
      body: '',
    })
    expect(notificationCopy({ type: 'friend_accepted', name: 'Maya' })).toEqual({
      title: 'You and Maya are friends',
      body: '',
    })
    expect(notificationCopy({ type: 'follow', name: 'Sam' })).toEqual({
      title: 'Sam followed you',
      body: '',
    })
    expect(
      notificationCopy({ type: 'group_invitation', name: 'Xavier', groupName: 'Weekend Crew' }),
    ).toEqual({ title: 'Xavier brought you into Weekend Crew', body: '' })
  })

  it('agrees with the room naming module for Lives', () => {
    const p = (id: string, displayName: string): NamingParticipant => ({
      id,
      displayName,
      isGuest: false,
      mediaState: 'camera',
      status: 'active',
      relation: 'friend',
      joinedAt: `2026-09-03T12:00:0${id.length}Z`,
    })
    const fromRoom = liveNotificationCopy({
      kind: 'group',
      contextTitle: 'Weekend Crew',
      participants: [p('x', 'Xavier'), p('ma', 'Maya'), p('sam', 'Sam'), p('benn', 'Ben')],
    })
    expect(fromRoom).not.toBeNull()
    if (fromRoom === null) return
    expect(
      notificationCopy({
        type: 'group_live',
        groupName: 'Weekend Crew',
        names: ['Xavier', 'Maya', 'Sam'],
        total: 4,
      }),
    ).toEqual({ title: fromRoom.title, body: fromRoom.body })
    const single = liveNotificationCopy({
      kind: 'standalone',
      contextTitle: null,
      participants: [p('x', 'Xavier')],
      activityTitle: 'Cooking dinner',
    })
    expect(single).toEqual({
      type: 'friend_live',
      ...notificationCopy({ type: 'friend_live', name: 'Xavier', activity: 'Cooking dinner' }),
    })
  })
})

describe('payload parsing (notifications_list payload carries names)', () => {
  it('has a schema for every type', () => {
    expect(Object.keys(NOTIFICATION_PAYLOAD_SCHEMAS).sort()).toEqual([...NOTIFICATION_TYPES].sort())
  })

  it('builds inputs from stored payloads', () => {
    expect(
      notificationCopyInputFromPayload('direct_message', { senderName: 'Xavier', preview: 'hi' }),
    ).toEqual({ type: 'direct_message', senderName: 'Xavier', preview: 'hi' })
    expect(notificationCopyInputFromPayload('direct_message', { senderName: 'Xavier' })).toEqual({
      type: 'direct_message',
      senderName: 'Xavier',
      preview: '',
    })
    expect(
      notificationCopyInputFromPayload('group_message', {
        groupName: 'Weekend Crew',
        senderName: 'Maya',
        preview: 'yo',
      }),
    ).toEqual({
      type: 'group_message',
      groupName: 'Weekend Crew',
      senderName: 'Maya',
      preview: 'yo',
    })
    expect(notificationCopyInputFromPayload('friend_live', { name: 'Xavier' })).toEqual({
      type: 'friend_live',
      name: 'Xavier',
      activity: null,
    })
    expect(
      notificationCopyInputFromPayload('friend_live', {
        name: 'Xavier',
        activity: 'Cooking dinner',
      }),
    ).toEqual({ type: 'friend_live', name: 'Xavier', activity: 'Cooking dinner' })
    expect(notificationCopyInputFromPayload('multi_live', { names: ['Xavier', ' Maya '] })).toEqual(
      { type: 'multi_live', names: ['Xavier', 'Maya'] },
    )
    expect(notificationCopyInputFromPayload('multi_live', { names: ['Xavier'], total: 3 })).toEqual(
      { type: 'multi_live', names: ['Xavier'], total: 3 },
    )
    expect(
      notificationCopyInputFromPayload('group_live', {
        groupName: 'Weekend Crew',
        names: ['Xavier', 'Maya'],
        total: 4,
      }),
    ).toEqual({
      type: 'group_live',
      groupName: 'Weekend Crew',
      names: ['Xavier', 'Maya'],
      total: 4,
    })
    expect(notificationCopyInputFromPayload('friend_request', { name: 'Maya' })).toEqual({
      type: 'friend_request',
      name: 'Maya',
    })
    expect(notificationCopyInputFromPayload('friend_accepted', { name: 'Maya' })).toEqual({
      type: 'friend_accepted',
      name: 'Maya',
    })
    expect(notificationCopyInputFromPayload('follow', { name: 'Sam' })).toEqual({
      type: 'follow',
      name: 'Sam',
    })
    expect(
      notificationCopyInputFromPayload('group_invitation', {
        name: 'Xavier',
        groupName: 'Weekend Crew',
      }),
    ).toEqual({ type: 'group_invitation', name: 'Xavier', groupName: 'Weekend Crew' })
  })

  it('returns null for unusable payloads instead of throwing', () => {
    const bad: Record<NotificationType, unknown> = {
      direct_message: {},
      group_message: { groupName: 'Crew' },
      friend_live: { name: '' },
      multi_live: { names: [] },
      group_live: { names: ['Xavier'] },
      friend_request: null,
      friend_accepted: 'Maya',
      follow: { name: 3 },
      group_invitation: { name: 'Xavier' },
    }
    for (const type of NOTIFICATION_TYPES) {
      expect(notificationCopyInputFromPayload(type, bad[type]), type).toBeNull()
      expect(notificationCopyFromPayload(type, bad[type]), type).toBeNull()
    }
    expect(notificationCopyFromPayload('follow', { name: 'Sam' })).toEqual({
      title: 'Sam followed you',
      body: '',
    })
  })
})
