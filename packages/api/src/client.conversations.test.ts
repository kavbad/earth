import { MESSAGES_PAGE_SIZE, asConversationId, asHumanId, asMessageId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { RPC } from './rpc'
import { earthRejection } from './testing/expect'
import { postgrestRaise } from './testing/fake-supabase'
import * as fixtures from './testing/fixtures'
import { createTestClient } from './testing/harness'

const { IDS } = fixtures
const CONVERSATION = asConversationId(IDS.conversation)
const MESSAGE = asMessageId(IDS.message)
const MAYA = asHumanId(IDS.maya)
const KAVON = asHumanId(IDS.kavon)

describe('conversations', () => {
  it('list defaults cursor and limit to null and returns the page', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.conversationsList, fixtures.conversationsPage())
    const page = await client.conversations.list()
    expect(supabase.lastRpc()).toEqual({
      name: 'conversations_list',
      args: { cursor: null, limit: null },
    })
    expect(page.conversations[0]?.title).toBe('Weekend Crew')
    expect(page.nextCursor).toBe(fixtures.AT)
    supabase.rpcData(RPC.conversationsList, { conversations: [] })
    expect(
      (await client.conversations.list({ cursor: fixtures.AT, limit: 10 })).nextCursor,
    ).toBeNull()
    expect(supabase.lastRpc().args).toEqual({ cursor: fixtures.AT, limit: 10 })
  })

  it('get, directWith and createGroup map their rpcs', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.conversationGet, fixtures.conversationDetail())
    expect((await client.conversations.get(CONVERSATION)).members).toHaveLength(2)
    expect(supabase.lastRpc()).toEqual({
      name: 'conversation_get',
      args: { conversation_id: IDS.conversation },
    })
    supabase.rpcData(
      RPC.conversationDirectGetOrCreate,
      fixtures.conversationSummary({ type: 'direct', groupId: null }),
    )
    expect((await client.conversations.directWith(MAYA)).type).toBe('direct')
    expect(supabase.lastRpc()).toEqual({
      name: 'conversation_direct_get_or_create',
      args: { other_human_id: IDS.maya },
    })
    supabase.rpcData(RPC.conversationGroupCreate, fixtures.conversationSummary())
    await client.conversations.createGroup([MAYA, KAVON])
    expect(supabase.lastRpc()).toEqual({
      name: 'conversation_group_create',
      args: { human_ids: [IDS.maya, IDS.kavon] },
    })
    expect((await earthRejection(client.conversations.createGroup([MAYA]))).code).toBe(
      'invalid_input',
    )
  })

  it('create dispatches by member count', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(
      RPC.conversationDirectGetOrCreate,
      fixtures.conversationSummary({ type: 'direct', groupId: null }),
    )
    supabase.rpcData(RPC.conversationGroupCreate, fixtures.conversationSummary())
    await client.conversations.create({ humanIds: [MAYA] })
    expect(supabase.lastRpc().name).toBe('conversation_direct_get_or_create')
    await client.conversations.create({ humanIds: [MAYA, KAVON] })
    expect(supabase.lastRpc().name).toBe('conversation_group_create')
    expect((await earthRejection(client.conversations.create({ humanIds: [] }))).code).toBe(
      'invalid_input',
    )
  })

  it('directWith surfaces blocked', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcError(RPC.conversationDirectGetOrCreate, postgrestRaise('blocked'))
    expect((await earthRejection(client.conversations.directWith(MAYA))).code).toBe('blocked')
  })

  it('setPrefs, readReceipts and markRead map their rpcs', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.conversationSetPrefs, fixtures.conversationPrefs())
    expect(
      (await client.conversations.setPrefs({ conversationId: CONVERSATION, muteState: 'muted' }))
        .muteState,
    ).toBe('muted')
    expect(supabase.lastRpc()).toEqual({
      name: 'conversation_set_prefs',
      args: { conversation_id: IDS.conversation, mute_state: 'muted', notification_level: null },
    })
    supabase.rpcData(RPC.conversationReadReceipts, [fixtures.readReceipt()])
    expect((await client.conversations.readReceipts(CONVERSATION))[0]?.lastReadMessageId).toBe(
      IDS.message,
    )
    supabase.rpcData(RPC.conversationMarkRead, {
      conversationId: IDS.conversation,
      lastReadMessageId: IDS.message,
      lastReadAt: fixtures.AT,
      unreadCount: 0,
    })
    expect(
      await client.conversations.markRead({
        conversationId: CONVERSATION,
        lastReadMessageId: MESSAGE,
      }),
    ).toEqual({
      conversationId: IDS.conversation,
      lastReadMessageId: IDS.message,
      lastReadAt: fixtures.AT,
      unreadCount: 0,
    })
    expect(supabase.lastRpc()).toEqual({
      name: 'conversation_mark_read',
      args: { conversation_id: IDS.conversation, message_id: IDS.message },
    })
  })
})

describe('conversations.messages', () => {
  it('list uses keyset args and the default page size', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.messagesList, fixtures.messagesPage())
    const page = await client.conversations.messages.list({ conversationId: CONVERSATION })
    expect(supabase.lastRpc()).toEqual({
      name: 'messages_list',
      args: { conversation_id: IDS.conversation, before_id: null, limit: MESSAGES_PAGE_SIZE },
    })
    expect(page.messages[0]?.reactions[0]?.count).toBe(2)
    await client.conversations.messages.list({
      conversationId: CONVERSATION,
      beforeId: MESSAGE,
      limit: 5,
    })
    expect(supabase.lastRpc().args).toEqual({
      conversation_id: IDS.conversation,
      before_id: IDS.message,
      limit: 5,
    })
  })

  it('since accepts a bare array or a wrapped list', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.messagesSince, [fixtures.messageDto()])
    expect(
      await client.conversations.messages.since({ conversationId: CONVERSATION, afterId: null }),
    ).toHaveLength(1)
    expect(supabase.lastRpc()).toEqual({
      name: 'messages_since',
      args: { conversation_id: IDS.conversation, after_id: null },
    })
    supabase.rpcData(RPC.messagesSince, {
      messages: [fixtures.messageDto(), fixtures.messageDto({ id: IDS.message2 })],
    })
    expect(
      await client.conversations.messages.since({ conversationId: CONVERSATION, afterId: MESSAGE }),
    ).toHaveLength(2)
    expect(supabase.lastRpc().args).toEqual({
      conversation_id: IDS.conversation,
      after_id: IDS.message,
    })
  })

  it('since reads a null result (jsonb_agg over no rows) as an empty catch-up, not an error', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.messagesSince, null)
    expect(
      await client.conversations.messages.since({ conversationId: CONVERSATION, afterId: MESSAGE }),
    ).toEqual([])
    supabase.rpcData(RPC.messagesSince, { messages: null })
    expect(
      await client.conversations.messages.since({ conversationId: CONVERSATION, afterId: MESSAGE }),
    ).toEqual([])
    // A malformed message is still a contract error.
    supabase.rpcData(RPC.messagesSince, [{ id: 'nope' }])
    expect(
      (
        await earthRejection(
          client.conversations.messages.since({ conversationId: CONVERSATION, afterId: null }),
        )
      ).code,
    ).toBe('internal')
  })

  it('send maps every argument and applies the payload default', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.messageSend, fixtures.messageDto())
    const message = await client.conversations.messages.send({
      conversationId: CONVERSATION,
      clientId: IDS.client,
      type: 'text',
      text: 'hi',
      replyToMessageId: null,
    })
    expect(supabase.lastRpc()).toEqual({
      name: 'message_send',
      args: {
        conversation_id: IDS.conversation,
        client_id: IDS.client,
        type: 'text',
        text: 'hi',
        payload: {},
        reply_to_message_id: null,
      },
    })
    expect(message.clientId).toBe(IDS.client)
  })

  it('send rejects empty text messages and system messages locally', async () => {
    const { client, supabase } = createTestClient()
    expect(
      (
        await earthRejection(
          client.conversations.messages.send({
            conversationId: CONVERSATION,
            clientId: IDS.client,
            type: 'text',
            text: '  ',
            replyToMessageId: null,
          }),
        )
      ).code,
    ).toBe('invalid_input')
    expect(
      (
        await earthRejection(
          client.conversations.messages.send({
            conversationId: CONVERSATION,
            clientId: IDS.client,
            type: 'system' as never,
            text: 'x',
            replyToMessageId: null,
          }),
        )
      ).code,
    ).toBe('invalid_input')
    expect(supabase.rpcCalls).toHaveLength(0)
  })

  it('send surfaces rate limits', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcError(RPC.messageSend, postgrestRaise('rate_limited'))
    expect(
      (
        await earthRejection(
          client.conversations.messages.send({
            conversationId: CONVERSATION,
            clientId: IDS.client,
            type: 'text',
            text: 'hi',
            replyToMessageId: null,
          }),
        )
      ).code,
    ).toBe('rate_limited')
  })

  it('edit, delete and reactions.toggle map their rpcs and return the message', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(
      RPC.messageEdit,
      fixtures.messageDto({ text: 'edited', editedAt: fixtures.AT }),
    )
    expect(
      (await client.conversations.messages.edit({ messageId: MESSAGE, text: 'edited' })).editedAt,
    ).toBe(fixtures.AT)
    expect(supabase.lastRpc()).toEqual({
      name: 'message_edit',
      args: { message_id: IDS.message, text: 'edited' },
    })
    supabase.rpcData(RPC.messageDelete, fixtures.messageDto({ text: null, deletedAt: fixtures.AT }))
    expect((await client.conversations.messages.delete(MESSAGE)).deletedAt).toBe(fixtures.AT)
    expect(supabase.lastRpc()).toEqual({
      name: 'message_delete',
      args: { message_id: IDS.message },
    })
    supabase.rpcData(
      RPC.messageReactionToggle,
      fixtures.messageDto({ reactions: [{ reaction: '❤️', count: 1, reactedByMe: true }] }),
    )
    expect(
      (await client.conversations.messages.reactions.toggle({ messageId: MESSAGE, reaction: '❤️' }))
        .reactions,
    ).toEqual([{ reaction: '❤️', count: 1, reactedByMe: true }])
    expect(supabase.lastRpc()).toEqual({
      name: 'message_reaction_toggle',
      args: { message_id: IDS.message, reaction: '❤️' },
    })
  })
})
