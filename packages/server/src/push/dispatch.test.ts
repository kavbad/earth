import { PRESENCE_ACTIVE_WINDOW_SECONDS } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  groupByRecipient,
  handlePushDispatch,
  isRecipientActiveInConversation,
  planDispatch,
  tallyTickets,
} from './dispatch'
import { CRON_SECRET_HEADER } from '../cron'
import { TEST_CRON_SECRET, TEST_NOW, createFakeDeps, fakeRequest } from '../test/fakes'
import { CONVERSATION_ID, RECIPIENT_B, ROOM_ID, notification } from '../test/fixtures'

const cronHeaders = { [CRON_SECRET_HEADER]: TEST_CRON_SECRET }

function dispatchRequest(body?: unknown, url = '/api/internal/push/dispatch') {
  return fakeRequest({ method: 'POST', url, headers: cronHeaders, body })
}

describe('planDispatch', () => {
  it('groups by recipient and builds one message per token with spec copy and deep-link data', () => {
    const rows = [
      notification(1, {
        pushTokens: [
          { token: 'ExponentPushToken[a]', platform: 'ios' },
          { token: 'ExponentPushToken[b]', platform: 'android' },
        ],
      }),
      notification(2, {
        recipientHumanId: RECIPIENT_B,
        type: 'friend_live',
        priority: 'critical_social',
        objectType: 'room',
        objectId: ROOM_ID,
        payload: { name: 'Xavier', activity: 'Cooking dinner' },
        pushTokens: [{ token: 'ExponentPushToken[c]', platform: 'ios' }],
      }),
      notification(3, {
        recipientHumanId: RECIPIENT_B,
        type: 'follow',
        priority: 'normal',
        objectType: 'human',
        objectId: RECIPIENT_B,
        payload: { name: 'Sam' },
      }),
    ]
    const plan = planDispatch(rows, TEST_NOW)
    expect(groupByRecipient(rows).size).toBe(2)
    expect(plan.recipients).toBe(2)
    expect(plan.messages).toHaveLength(4)
    expect(plan.messages.slice(0, 2).map((m) => m.message.to)).toEqual([
      'ExponentPushToken[a]',
      'ExponentPushToken[b]',
    ])
    expect(plan.messages[0]?.message).toMatchObject({
      title: 'Xavier',
      body: 'hey 1',
      priority: 'high',
      channelId: 'messages',
      data: {
        notificationId: rows[0]?.id,
        type: 'direct_message',
        objectType: 'message',
        objectId: rows[0]?.objectId,
        conversationId: CONVERSATION_ID,
      },
    })
    expect(plan.messages[2]?.message).toMatchObject({
      title: 'Xavier is live',
      body: 'Cooking dinner',
      priority: 'high',
      channelId: 'live',
      data: { type: 'friend_live', objectType: 'room', objectId: ROOM_ID, roomId: ROOM_ID },
    })
    expect(plan.messages[2]?.message.data).not.toHaveProperty('conversationId')
    expect(plan.messages[3]?.message).toMatchObject({
      title: 'Sam followed you',
      body: '',
      priority: 'normal',
      channelId: 'social',
    })
    expect(plan.handledWithoutSend).toEqual([])
  })

  it('suppresses recipients active in the very conversation and marks them handled', () => {
    const active = notification(1, {
      presence: {
        lastActiveAt: new Date(TEST_NOW.getTime() - 5_000).toISOString(),
        activeConversationId: CONVERSATION_ID,
        activeRoomId: null,
      },
    })
    const stale = notification(2, {
      presence: {
        lastActiveAt: new Date(
          TEST_NOW.getTime() - (PRESENCE_ACTIVE_WINDOW_SECONDS + 1) * 1000,
        ).toISOString(),
        activeConversationId: CONVERSATION_ID,
        activeRoomId: null,
      },
    })
    const elsewhere = notification(3, {
      presence: {
        lastActiveAt: TEST_NOW.toISOString(),
        activeConversationId: ROOM_ID,
        activeRoomId: null,
      },
    })
    const live = notification(4, {
      type: 'friend_live',
      priority: 'critical_social',
      objectType: 'room',
      objectId: ROOM_ID,
      payload: { name: 'Xavier' },
      presence: {
        lastActiveAt: TEST_NOW.toISOString(),
        activeConversationId: CONVERSATION_ID,
        activeRoomId: null,
      },
    })
    expect(isRecipientActiveInConversation(active, TEST_NOW)).toBe(true)
    expect(isRecipientActiveInConversation(stale, TEST_NOW)).toBe(false)
    expect(isRecipientActiveInConversation(elsewhere, TEST_NOW)).toBe(false)
    expect(isRecipientActiveInConversation(live, TEST_NOW)).toBe(false)
    const plan = planDispatch([active, stale, elsewhere, live], TEST_NOW)
    expect(plan.suppressed).toBe(1)
    expect(plan.handledWithoutSend).toEqual([active.id])
    expect(plan.messages).toHaveLength(3)
  })

  it('skips notifications without tokens or without usable copy', () => {
    const noTokens = notification(1, { pushTokens: [] })
    const badPayload = notification(2, { payload: {} })
    const missing: string[] = []
    const plan = planDispatch([noTokens, badPayload], TEST_NOW, (row) => missing.push(row.id))
    expect(plan.messages).toHaveLength(0)
    expect(plan.skipped).toBe(2)
    expect(plan.handledWithoutSend).toEqual([noTokens.id, badPayload.id])
    expect(missing).toEqual([badPayload.id])
  })
})

describe('tallyTickets', () => {
  it('settles delivered and refused messages, defers only fully transient notifications', () => {
    const rows = [
      notification(1, {
        pushTokens: [
          { token: 'ExponentPushToken[a]', platform: 'ios' },
          { token: 'ExponentPushToken[b]', platform: 'ios' },
        ],
      }),
      notification(2),
      notification(3),
    ]
    const plan = planDispatch(rows, TEST_NOW)
    const tally = tallyTickets(plan.messages, [
      { status: 'error', message: 'down', transient: true },
      { status: 'ok', id: 't' },
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      { status: 'error', message: 'down', transient: true },
    ])
    expect(tally.sent).toBe(1)
    expect(tally.failed).toBe(1)
    expect(tally.deferred).toBe(2)
    expect([...tally.settled]).toEqual([rows[0]?.id, rows[1]?.id])
    expect([...tally.deferredIds]).toEqual([rows[2]?.id])
  })
})

describe('handlePushDispatch', () => {
  it('is cron protected', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { notifications_unsent: () => [] } })
    await expect(
      handlePushDispatch(deps, fakeRequest({ method: 'POST', url: '/x' })),
    ).rejects.toMatchObject({ code: 'not_authenticated' })
    expect(supabase.calls).toHaveLength(0)
  })

  it('fetches unsent rows as the service, sends, and marks pushed', async () => {
    const rows = [
      notification(1, {
        pushTokens: [
          { token: 'ExponentPushToken[a]', platform: 'ios' },
          { token: 'ExponentPushToken[b]', platform: 'android' },
        ],
      }),
      notification(2, {
        recipientHumanId: RECIPIENT_B,
        type: 'friend_request',
        objectType: 'human',
        objectId: RECIPIENT_B,
        payload: { name: 'Maya' },
      }),
      notification(3, { pushTokens: [] }),
      notification(4, {
        presence: {
          lastActiveAt: TEST_NOW.toISOString(),
          activeConversationId: CONVERSATION_ID,
          activeRoomId: null,
        },
      }),
    ]
    const marked: unknown[] = []
    const { deps, supabase, push } = createFakeDeps({
      rpc: {
        notifications_unsent: () => rows,
        notifications_mark_pushed: (args) => {
          marked.push(args['ids'])
          return { marked: (args['ids'] as string[]).length }
        },
      },
    })
    const res = await handlePushDispatch(deps, dispatchRequest())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      ok: true,
      ranAt: TEST_NOW.toISOString(),
      fetched: 4,
      recipients: 2,
      sent: 3,
      suppressed: 1,
      skipped: 1,
      failed: 0,
      deferred: 0,
      marked: 4,
    })
    expect(supabase.callsTo('notifications_unsent')[0]).toEqual({
      client: 'admin',
      name: 'notifications_unsent',
      args: { limit: 500 },
    })
    expect(push.batches).toHaveLength(1)
    expect(push.messages.map((m) => m.to)).toEqual([
      'ExponentPushToken[a]',
      'ExponentPushToken[b]',
      'ExponentPushToken[a2]',
    ])
    expect(push.messages[2]).toMatchObject({
      title: 'Maya wants to be friends',
      body: '',
      priority: 'high',
    })
    expect(supabase.callsTo('notifications_mark_pushed')[0]?.client).toBe('admin')
    expect(new Set(marked[0] as string[])).toEqual(new Set(rows.map((r) => r.id)))
  })

  it('leaves notifications with only transient failures unmarked, marks refused ones', async () => {
    const rows = [notification(1), notification(2), notification(3)]
    const marked: string[][] = []
    const { deps, push, logs } = createFakeDeps({
      rpc: {
        notifications_unsent: () => rows,
        notifications_mark_pushed: (args) => {
          marked.push(args['ids'] as string[])
          return null
        },
      },
    })
    push.ticketFor = (message) =>
      message.to.endsWith('[a1]')
        ? { status: 'error', message: 'gateway', transient: true }
        : message.to.endsWith('[a2]')
          ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
          : { status: 'ok', id: 'x' }
    const res = await handlePushDispatch(deps, dispatchRequest({ limit: 50 }))
    expect(res.body).toMatchObject({ fetched: 3, sent: 1, failed: 1, deferred: 1, marked: 2 })
    expect(marked[0]).toEqual([rows[1]?.id, rows[2]?.id])
    expect(logs.records.filter((r) => r.msg === 'push.ticket_error')).toHaveLength(2)
    const { deps: d2, supabase } = createFakeDeps({ rpc: { notifications_unsent: () => [] } })
    await handlePushDispatch(d2, dispatchRequest({ limit: 50 }))
    expect(supabase.callsTo('notifications_unsent')[0]?.args).toEqual({ limit: 50 })
  })

  it('does not call mark_pushed when nothing was handled and validates the limit', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { notifications_unsent: () => null } })
    const res = await handlePushDispatch(
      deps,
      dispatchRequest(undefined, '/api/internal/push/dispatch?limit=7'),
    )
    expect(res.body).toMatchObject({ fetched: 0, marked: 0 })
    expect(supabase.callsTo('notifications_unsent')[0]?.args).toEqual({ limit: 7 })
    expect(supabase.callsTo('notifications_mark_pushed')).toHaveLength(0)
    await expect(handlePushDispatch(deps, dispatchRequest({ limit: 0 }))).rejects.toMatchObject({
      code: 'invalid_input',
    })
  })

  it('refuses rows that violate the contract', async () => {
    const { deps } = createFakeDeps({
      rpc: { notifications_unsent: () => [{ ...notification(1), type: 'poke' }] },
    })
    await expect(handlePushDispatch(deps, dispatchRequest())).rejects.toMatchObject({
      code: 'internal',
    })
  })
})

describe('adversarial: only handled notifications are marked', () => {
  it('a notification refused on one device and transient on another is deferred, not marked', async () => {
    const row = notification(1, {
      pushTokens: [
        { token: 'ExponentPushToken[dead]', platform: 'ios' },
        { token: 'ExponentPushToken[flaky]', platform: 'android' },
      ],
    })
    const marked: string[][] = []
    const { deps, push } = createFakeDeps({
      rpc: {
        notifications_unsent: () => [row],
        notifications_mark_pushed: (args) => {
          marked.push(args['ids'] as string[])
          return null
        },
      },
    })
    push.ticketFor = (message) =>
      message.to.includes('dead')
        ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
        : { status: 'error', message: 'gateway', transient: true }
    const res = await handlePushDispatch(deps, dispatchRequest())
    expect(res.body).toMatchObject({ sent: 0, failed: 1, deferred: 1, marked: 0 })
    expect(marked).toEqual([])
  })

  it('a notification with every device refused is marked (never retried forever)', () => {
    const row = notification(1, {
      pushTokens: [
        { token: 'ExponentPushToken[a]', platform: 'ios' },
        { token: 'ExponentPushToken[b]', platform: 'ios' },
      ],
    })
    const plan = planDispatch([row], TEST_NOW)
    const tally = tallyTickets(plan.messages, [
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
    ])
    expect([...tally.settled]).toEqual([row.id])
    expect([...tally.deferredIds]).toEqual([])
  })

  it('a sender that throws marks nothing that was planned for sending and answers 200', async () => {
    const rows = [notification(1), notification(2, { pushTokens: [] })]
    const marked: string[][] = []
    const { deps, logs } = createFakeDeps({
      rpc: {
        notifications_unsent: () => rows,
        notifications_mark_pushed: (args) => {
          marked.push(args['ids'] as string[])
          return null
        },
      },
    })
    const throwing = { ...deps, push: { send: async () => Promise.reject(new Error('expo down')) } }
    const res = await handlePushDispatch(throwing, dispatchRequest())
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ fetched: 2, sent: 0, deferred: 1, skipped: 1, marked: 1 })
    expect(marked).toEqual([[rows[1]?.id]])
    expect(logs.records.some((r) => r.msg === 'push.send_failed' && r.level === 'error')).toBe(true)
  })

  it('a ticket list shorter than the message list defers the unanswered notifications', async () => {
    const rows = [notification(1), notification(2)]
    const marked: string[][] = []
    const { deps } = createFakeDeps({
      rpc: {
        notifications_unsent: () => rows,
        notifications_mark_pushed: (args) => {
          marked.push(args['ids'] as string[])
          return null
        },
      },
    })
    const short = { ...deps, push: { send: async () => [{ status: 'ok' as const, id: 't' }] } }
    const res = await handlePushDispatch(short, dispatchRequest())
    expect(res.body).toMatchObject({ sent: 1, deferred: 1, marked: 1 })
    expect(marked).toEqual([[rows[0]?.id]])
  })

  it('duplicate rows and duplicate tokens produce one push each and one mark', async () => {
    const row = notification(1, {
      pushTokens: [
        { token: 'ExponentPushToken[a]', platform: 'ios' },
        { token: 'ExponentPushToken[a]', platform: 'ios' },
      ],
    })
    const marked: string[][] = []
    const { deps, push } = createFakeDeps({
      rpc: {
        notifications_unsent: () => [row, row],
        notifications_mark_pushed: (args) => {
          marked.push(args['ids'] as string[])
          return null
        },
      },
    })
    const res = await handlePushDispatch(deps, dispatchRequest())
    expect(push.messages).toHaveLength(1)
    expect(res.body).toMatchObject({ fetched: 2, sent: 1, marked: 1 })
    expect(marked).toEqual([[row.id]])
  })

  it('the mark call contains exactly the handled ids and never a deferred one', async () => {
    const rows = [notification(1), notification(2), notification(3, { pushTokens: [] })]
    const marked: string[][] = []
    const { deps, push } = createFakeDeps({
      rpc: {
        notifications_unsent: () => rows,
        notifications_mark_pushed: (args) => {
          marked.push(args['ids'] as string[])
          return null
        },
      },
    })
    push.ticketFor = (message) =>
      message.to.endsWith('[a2]')
        ? { status: 'error', message: 'gateway', transient: true }
        : { status: 'ok', id: 'x' }
    await handlePushDispatch(deps, dispatchRequest())
    expect(new Set(marked[0])).toEqual(new Set([rows[0]?.id, rows[2]?.id]))
  })

  it('a wrong cron secret is forbidden before any database call', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { notifications_unsent: () => [] } })
    await expect(
      handlePushDispatch(
        deps,
        fakeRequest({
          method: 'POST',
          url: '/x',
          headers: { [CRON_SECRET_HEADER]: `${TEST_CRON_SECRET}x` },
        }),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(supabase.calls).toHaveLength(0)
  })
})
