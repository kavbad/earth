/**
 * The chat's outbox wiring against a fake `EarthClient` (spec §53 steps 1–7, §54, §108): every
 * send goes through `message_send` with the client-generated id, retries reuse it, the reducer
 * renders pending → sent / failed, and a non-retryable server answer fails at once.
 */
import { RPC } from '@earth/api'
import { createTestClient, fixtures, postgrestRaise } from '@earth/api/testing'
import { type MessageSendInput, asConversationId, asHumanId } from '@earth/domain'
import { type OutboxItem, createOutbox } from '@earth/realtime'
import { createFakeClock, createMemoryOutboxStorage, flushPromises } from '@earth/realtime/testing'
import { describe, expect, it } from 'vitest'

import { createMemoryStorage } from '../../../lib/storage'
import { INITIAL_MESSAGES_STATE, type MessagesState, messagesReducer } from './messages'
import { createOutboxStorage, outboxStorageKey } from './outboxStorage'

const CONVERSATION = asConversationId(fixtures.IDS.conversation)
const XAVIER = asHumanId(fixtures.IDS.xavier)
const CLIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function sendInput(text = 'On my way', clientId = CLIENT_ID): MessageSendInput {
  return {
    conversationId: CONVERSATION,
    clientId,
    type: 'text',
    text,
    payload: {},
    replyToMessageId: null,
  }
}

interface Harness {
  readonly outbox: ReturnType<typeof createOutbox>
  readonly state: () => MessagesState
  readonly rpcCalls: () => ReadonlyArray<{
    name: string
    args: Record<string, unknown> | undefined
  }>
  online: boolean
}

function harness(options: { readonly sendFails?: 'blocked' | 'internal' | null } = {}): Harness {
  const { client, supabase } = createTestClient({ accessToken: 'token' })
  const acknowledged = fixtures.messageDto({
    id: fixtures.IDS.message,
    senderHumanId: XAVIER,
    clientId: CLIENT_ID,
    text: 'On my way',
    reactions: [],
  })
  if (options.sendFails === 'blocked') supabase.rpcError(RPC.messageSend, postgrestRaise('blocked'))
  else if (options.sendFails === 'internal') {
    supabase.rpcError(RPC.messageSend, { message: 'connection reset', code: '08006' })
  } else supabase.rpcData(RPC.messageSend, acknowledged)

  let state = INITIAL_MESSAGES_STATE
  const dispatch = (action: Parameters<typeof messagesReducer>[1]) => {
    state = messagesReducer(state, action)
  }
  const result: Harness = {
    online: true,
    outbox: createOutbox({
      storage: createMemoryOutboxStorage(),
      clock: createFakeClock(),
      senderHumanId: XAVIER,
      isOnline: () => result.online,
      // Exactly what `useConversation` passes: the typed client method, reusing the item's clientId.
      send: (item: OutboxItem) => client.conversations.messages.send(item.input),
      onSent: (message, item) => dispatch({ type: 'sent', clientId: item.clientId, message }),
    }),
    state: () => state,
    rpcCalls: () => supabase.rpcCalls,
  }
  result.outbox.subscribe((snapshot) =>
    dispatch({
      type: 'outbox',
      messages: snapshot.items.map((item) => result.outbox.optimisticMessage(item)),
    }),
  )
  return result
}

describe('chat outbox integration', () => {
  it('renders the message pending, sends it through message_send with the client id, then shows the DTO', async () => {
    const h = harness()
    const optimistic = await h.outbox.enqueue(sendInput())
    expect(optimistic.status).toBe('pending')
    expect(h.state().messages.map((m) => [m.id, m.status])).toEqual([[CLIENT_ID, 'pending']])
    await flushPromises(20)
    const calls = h.rpcCalls().filter((call) => call.name === RPC.messageSend)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.args).toMatchObject({
      conversation_id: CONVERSATION,
      client_id: CLIENT_ID,
      type: 'text',
      text: 'On my way',
    })
    expect(h.state().messages.map((m) => [m.id, m.status])).toEqual([
      [fixtures.IDS.message, 'sent'],
    ])
    expect(h.outbox.state().items).toHaveLength(0)
  })

  it('queues while offline and flushes once online without duplicating the send', async () => {
    const h = harness()
    h.online = false
    await h.outbox.enqueue(sendInput())
    await flushPromises(10)
    expect(h.rpcCalls().filter((call) => call.name === RPC.messageSend)).toHaveLength(0)
    expect(h.state().messages[0]?.status).toBe('pending')
    h.online = true
    await h.outbox.flush()
    await h.outbox.flush()
    expect(h.rpcCalls().filter((call) => call.name === RPC.messageSend)).toHaveLength(1)
    expect(h.state().messages[0]?.status).toBe('sent')
  })

  it('fails at once on a non-retryable server error and retries with the same client id on tap', async () => {
    const h = harness({ sendFails: 'blocked' })
    await h.outbox.enqueue(sendInput())
    await flushPromises(20)
    expect(h.state().messages[0]?.status).toBe('failed')
    expect(h.rpcCalls().filter((call) => call.name === RPC.messageSend)).toHaveLength(1)
    await h.outbox.retry(CLIENT_ID)
    const calls = h.rpcCalls().filter((call) => call.name === RPC.messageSend)
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.args?.['client_id'] === CLIENT_ID)).toBe(true)
    expect(h.state().messages[0]?.status).toBe('failed')
  })

  it('retries transient failures up to the attempt limit, then marks the message failed', async () => {
    const h = harness({ sendFails: 'internal' })
    await h.outbox.enqueue(sendInput())
    await flushPromises(20)
    expect(h.state().messages[0]?.status).toBe('pending')
    await h.outbox.flush()
    await h.outbox.flush()
    expect(h.rpcCalls().filter((call) => call.name === RPC.messageSend)).toHaveLength(3)
    expect(h.state().messages[0]?.status).toBe('failed')
    await h.outbox.remove(CLIENT_ID)
    expect(h.state().messages).toHaveLength(0)
  })

  it('persists the queue per Human and conversation on the device', async () => {
    const store = createMemoryStorage()
    const storage = createOutboxStorage(store, XAVIER, CONVERSATION)
    expect(await storage.get()).toEqual([])
    const item: OutboxItem = {
      clientId: CLIENT_ID,
      conversationId: CONVERSATION,
      input: sendInput(),
      attempts: 0,
      lastError: null,
      status: 'pending',
      createdAt: fixtures.AT,
    }
    await storage.set([item])
    expect(store.values.has(outboxStorageKey(XAVIER, CONVERSATION))).toBe(true)
    expect(await storage.get()).toEqual([item])
    // Unusable storage reads as an empty queue.
    expect(await createOutboxStorage(null, XAVIER, CONVERSATION).get()).toEqual([])
  })
})
