import {
  NOTIFICATIONS_PAGE_SIZE,
  asConversationId,
  asNotificationId,
  asRoomId,
} from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { RPC, SERVER_ROUTES } from './rpc'
import { earthRejection } from './testing/expect'
import * as fixtures from './testing/fixtures'
import { createTestClient } from './testing/harness'

const { IDS, AT } = fixtures

describe('notifications', () => {
  it('list uses the default page size and parses the page', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.notificationsList, fixtures.notificationsPage())
    const page = await client.notifications.list()
    expect(supabase.lastRpc()).toEqual({
      name: 'notifications_list',
      args: { cursor: null, limit: NOTIFICATIONS_PAGE_SIZE },
    })
    expect(page.notifications[0]?.type).toBe('friend_live')
    await client.notifications.list({ cursor: 'c1', limit: 5 })
    expect(supabase.lastRpc().args).toEqual({ cursor: 'c1', limit: 5 })
  })

  it('markRead, markAllRead and unreadCount map their rpcs', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.notificationMarkRead, null)
    await client.notifications.markRead(asNotificationId(IDS.notification))
    expect(supabase.lastRpc()).toEqual({
      name: 'notification_mark_read',
      args: { id: IDS.notification },
    })
    supabase.rpcData(RPC.notificationsMarkAllRead, null)
    await client.notifications.markAllRead()
    expect(supabase.lastRpc()).toEqual({ name: 'notifications_mark_all_read', args: {} })
    supabase.rpcData(RPC.notificationsUnreadCount, { unreadCount: 7 })
    expect(await client.notifications.unreadCount()).toBe(7)
    expect(supabase.lastRpc()).toEqual({ name: 'notifications_unread_count', args: {} })
  })

  it('push tokens register and remove', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.pushTokenRegister, {
      token: 'ExponentPushToken[x]',
      platform: 'ios',
      updatedAt: AT,
    })
    await client.notifications.registerPushToken({ token: 'ExponentPushToken[x]', platform: 'ios' })
    expect(supabase.lastRpc()).toEqual({
      name: 'push_token_register',
      args: { token: 'ExponentPushToken[x]', platform: 'ios' },
    })
    supabase.rpcData(RPC.pushTokenRemove, { removed: true })
    await client.notifications.removePushToken('ExponentPushToken[x]')
    expect(supabase.lastRpc()).toEqual({
      name: 'push_token_remove',
      args: { token: 'ExponentPushToken[x]' },
    })
    expect(
      (await earthRejection(client.notifications.registerPushToken({ token: '', platform: 'ios' })))
        .code,
    ).toBe('invalid_input')
  })
})

describe('presence', () => {
  it('ping sends nulls by default and ids when given', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.presencePing, null)
    await client.presence.ping()
    expect(supabase.lastRpc()).toEqual({
      name: 'presence_ping',
      args: { conversation_id: null, room_id: null, platform: null },
    })
    await client.presence.ping({
      conversationId: asConversationId(IDS.conversation),
      roomId: asRoomId(IDS.room),
      platform: 'android',
    })
    expect(supabase.lastRpc().args).toEqual({
      conversation_id: IDS.conversation,
      room_id: IDS.room,
      platform: 'android',
    })
  })
})

describe('analytics / diagnostics', () => {
  it('ingest posts the batch with an optional bearer', async () => {
    const { client, fetch } = createTestClient({
      accessToken: 'tok',
      fetchHandler: { status: 202 },
    })
    const batch = {
      v: 1 as const,
      sentAt: AT,
      events: [{ name: 'feed_scope_switched', properties: { scope: 'city' } }],
    }
    await client.analytics.ingest(batch)
    const request = fetch.lastRequest()
    expect(request.url).toBe(`https://api.earth.test${SERVER_ROUTES.analyticsIngest}`)
    expect(request.method).toBe('POST')
    expect(request.headers['authorization']).toBe('Bearer tok')
    expect(request.body).toEqual(batch)
  })

  it('ingest works anonymously and validates the batch', async () => {
    const { client, fetch } = createTestClient({ fetchHandler: { status: 202 } })
    await client.analytics.ingest({
      v: 1,
      sentAt: AT,
      events: [{ name: 'app_opened', properties: {} }],
    })
    expect(fetch.lastRequest().headers['authorization']).toBeUndefined()
    expect(
      (await earthRejection(client.analytics.ingest({ v: 1, sentAt: AT, events: [] }))).code,
    ).toBe('invalid_input')
    expect(
      (
        await earthRejection(
          client.analytics.ingest({
            v: 2 as never,
            sentAt: AT,
            events: [{ name: 'x', properties: {} }],
          }),
        )
      ).code,
    ).toBe('invalid_input')
  })

  it('ingest maps a 429 to rate_limited', async () => {
    const { client } = createTestClient({
      fetchHandler: {
        status: 429,
        json: { error: { code: 'rate_limited', message: 'rate_limited' } },
      },
    })
    expect(
      (
        await earthRejection(
          client.analytics.ingest({ v: 1, sentAt: AT, events: [{ name: 'x', properties: {} }] }),
        )
      ).code,
    ).toBe('rate_limited')
  })

  it('diagnostics.rtc posts the envelope', async () => {
    const { client, fetch } = createTestClient({ fetchHandler: { status: 202 } })
    await client.diagnostics.rtc({
      v: 1,
      ts: AT,
      event: { kind: 'realtime_fallback', reason: 'timeout', roomId: IDS.room },
    })
    expect(fetch.lastRequest().url).toBe(`https://api.earth.test${SERVER_ROUTES.diagnosticsRtc}`)
    expect(fetch.lastRequest().body).toEqual({
      v: 1,
      ts: AT,
      event: { kind: 'realtime_fallback', reason: 'timeout', roomId: IDS.room },
    })
    expect(
      (await earthRejection(client.diagnostics.rtc({ v: 1, ts: 'now', event: { kind: 'x' } })))
        .code,
    ).toBe('invalid_input')
  })
})
