import {
  EarthError,
  type MessageDto,
  type MessageSendInput,
  MessageSendInputSchema,
  asConversationId,
  asHumanId,
  asMessageId,
} from '@earth/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  type CreateOutboxOptions,
  OUTBOX_MAX_ATTEMPTS,
  type OutboxItem,
  type OutboxState,
  createOutbox,
  parseOutboxItems,
} from './queue'
import { createFakeClock, flushPromises } from './testing/fake-clock'
import { createMemoryOutboxStorage, createRecordingDiagnostics } from './testing/fakes'

const CONVERSATION_ID = asConversationId('11111111-1111-4111-8111-111111111111')
const ME = asHumanId('22222222-2222-4222-8222-222222222222')
const C1 = '44444444-4444-4444-8444-444444444441'
const C2 = '44444444-4444-4444-8444-444444444442'
const SERVER_ID = '33333333-3333-4333-8333-333333333331'

function input(clientId: string, text = 'hi'): MessageSendInput {
  return MessageSendInputSchema.parse({
    conversationId: CONVERSATION_ID,
    clientId,
    type: 'text',
    text,
    replyToMessageId: null,
  })
}

function serverMessage(item: OutboxItem): MessageDto {
  return {
    id: asMessageId(SERVER_ID),
    conversationId: item.conversationId,
    senderHumanId: ME,
    type: item.input.type,
    text: item.input.text,
    payload: item.input.payload,
    replyToMessageId: null,
    createdAt: '2026-09-03T12:00:01.000Z',
    editedAt: null,
    deletedAt: null,
    clientId: item.clientId,
    reactions: [],
  }
}

function setup(overrides: Partial<CreateOutboxOptions> = {}, seed: unknown = []) {
  const storage = createMemoryOutboxStorage(seed)
  const clock = createFakeClock(Date.parse('2026-09-03T12:00:00.000Z'))
  const diagnostics = createRecordingDiagnostics()
  const online = { value: true }
  const send = vi.fn(async (item: OutboxItem): Promise<MessageDto> => serverMessage(item))
  const onSent = vi.fn()
  const states: OutboxState[] = []
  const outbox = createOutbox({
    storage,
    send,
    isOnline: () => online.value,
    senderHumanId: ME,
    clock,
    diagnostics,
    onSent,
    autoFlush: false,
    ...overrides,
  })
  outbox.subscribe((state) => states.push(state))
  return { storage, clock, diagnostics, online, send, onSent, states, outbox }
}

describe('parseOutboxItems', () => {
  it('keeps well-formed items, resumes interrupted sends and drops the rest', () => {
    const good = {
      clientId: C1,
      conversationId: CONVERSATION_ID,
      input: input(C1),
      attempts: 1,
      lastError: 'net',
      status: 'sending',
      createdAt: '2026-09-03T12:00:00.000Z',
    }
    const items = parseOutboxItems([
      good,
      { ...good, clientId: C2, input: input(C1) }, // clientId mismatch
      { ...good, clientId: C1 }, // duplicate
      { ...good, clientId: C2, input: { nope: true } },
      { ...good, clientId: C2, input: input(C2), attempts: -1 },
      { ...good, clientId: C2, input: input(C2), status: 'weird' },
      { ...good, clientId: C2, input: input(C2), createdAt: 'yesterday' },
      'garbage',
      null,
    ])
    expect(items).toEqual([{ ...good, status: 'pending' }])
    expect(parseOutboxItems(undefined)).toEqual([])
    expect(parseOutboxItems({})).toEqual([])
  })
})

describe('createOutbox', () => {
  it('enqueue persists the item and returns a pending optimistic message', async () => {
    const { storage, states, outbox } = setup()
    const optimistic = await outbox.enqueue(input(C1, 'hello'))
    expect(optimistic).toEqual({
      id: C1,
      conversationId: CONVERSATION_ID,
      senderHumanId: ME,
      type: 'text',
      text: 'hello',
      payload: {},
      replyToMessageId: null,
      createdAt: '2026-09-03T12:00:00.000Z',
      editedAt: null,
      deletedAt: null,
      clientId: C1,
      reactions: [],
      status: 'pending',
    })
    expect(storage.value).toEqual([
      {
        clientId: C1,
        conversationId: CONVERSATION_ID,
        input: input(C1, 'hello'),
        attempts: 0,
        lastError: null,
        status: 'pending',
        createdAt: '2026-09-03T12:00:00.000Z',
      },
    ])
    expect(states.at(-1)).toMatchObject({ flushing: false })
    expect(states.at(-1)?.items).toHaveLength(1)

    // Same clientId again is not a second message.
    const again = await outbox.enqueue(input(C1, 'hello'))
    expect(again.id).toBe(C1)
    expect(outbox.state().items).toHaveLength(1)
  })

  it('flushes sequentially in order, reusing each clientId, and hands back the server DTO', async () => {
    const { storage, send, onSent, outbox } = setup()
    await outbox.enqueue(input(C1))
    await outbox.enqueue(input(C2))
    const result = await outbox.flush()
    expect(result).toEqual({ sent: 2, failed: 0, deferred: 0 })
    expect(send.mock.calls.map(([item]) => item.clientId)).toEqual([C1, C2])
    expect(send.mock.calls.map(([item]) => item.input.clientId)).toEqual([C1, C2])
    expect(onSent).toHaveBeenCalledTimes(2)
    expect(onSent.mock.calls[0]?.[0]).toMatchObject({ id: SERVER_ID, clientId: C1 })
    expect(outbox.state().items).toEqual([])
    expect(storage.value).toEqual([])
  })

  it('runs a single flush at a time', async () => {
    const { send, outbox } = setup()
    let release: () => void = () => undefined
    send.mockImplementationOnce(
      (item) =>
        new Promise<MessageDto>((resolve) => {
          release = () => resolve(serverMessage(item))
        }),
    )
    await outbox.enqueue(input(C1))
    const first = outbox.flush()
    const second = outbox.flush()
    expect(second).toBe(first)
    expect(outbox.state().flushing).toBe(true)
    await flushPromises()
    expect(outbox.state().items[0]?.status).toBe('sending')
    release()
    await expect(first).resolves.toEqual({ sent: 1, failed: 0, deferred: 0 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(outbox.state().flushing).toBe(false)
  })

  it('defers while offline and sends once back online', async () => {
    const { online, send, outbox } = setup()
    online.value = false
    await outbox.enqueue(input(C1))
    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 0, deferred: 1 })
    expect(send).not.toHaveBeenCalled()
    online.value = true
    await expect(outbox.flush()).resolves.toEqual({ sent: 1, failed: 0, deferred: 0 })
  })

  it('auto-flushes on enqueue when online', async () => {
    const { send, outbox } = setup({ autoFlush: true })
    await outbox.enqueue(input(C1))
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
    expect(outbox.state().items).toEqual([])
  })

  it('marks an item failed after three attempts and retries with the same clientId', async () => {
    const { diagnostics, send, storage, outbox } = setup()
    send.mockRejectedValue(new Error('network'))
    await outbox.enqueue(input(C1))
    await outbox.enqueue(input(C2))

    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 0, deferred: 2 })
    expect(outbox.state().items[0]).toMatchObject({
      attempts: 1,
      lastError: 'network',
      status: 'pending',
    })
    // A transient failure stops the pass so C2 never jumps ahead of C1.
    expect(send).toHaveBeenCalledTimes(1)

    await outbox.flush()
    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 1, deferred: 1 })
    expect(OUTBOX_MAX_ATTEMPTS).toBe(3)
    expect(outbox.state().items[0]).toMatchObject({ attempts: 3, status: 'failed' })
    expect(outbox.optimisticMessage(outbox.state().items[0] as OutboxItem).status).toBe('failed')
    expect(diagnostics.events).toEqual([
      {
        kind: 'message_send_failed',
        conversationId: CONVERSATION_ID,
        attempt: 3,
        reason: 'network',
      },
    ])
    // The failed item no longer blocks the next one, which used its own first attempt.
    expect(send.mock.calls.map(([item]) => item.clientId)).toEqual([C1, C1, C1, C2])
    expect(storage.value).toEqual(outbox.state().items)

    send.mockReset()
    send.mockImplementation(async (item) => serverMessage(item))
    await expect(outbox.retry(C1)).resolves.toEqual({ sent: 2, failed: 0, deferred: 0 })
    expect(send.mock.calls.map(([item]) => [item.clientId, item.attempts])).toEqual([
      [C1, 0],
      [C2, 1],
    ])
    expect(outbox.state().items).toEqual([])
    await expect(outbox.retry('missing')).resolves.toEqual({ sent: 0, failed: 0, deferred: 0 })
  })

  it('fails immediately on a non-retryable server error', async () => {
    const { diagnostics, send, outbox } = setup()
    send.mockRejectedValueOnce(new EarthError('blocked'))
    await outbox.enqueue(input(C1))
    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 1, deferred: 0 })
    expect(outbox.state().items[0]).toMatchObject({
      attempts: 1,
      status: 'failed',
      lastError: 'blocked',
    })
    expect(diagnostics.events[0]).toEqual({
      kind: 'message_send_failed',
      conversationId: CONVERSATION_ID,
      attempt: 1,
      reason: 'blocked',
      code: 'blocked',
    })

    send.mockRejectedValueOnce(new EarthError('rate_limited'))
    await outbox.enqueue(input(C2))
    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 0, deferred: 1 })
    expect(outbox.state().items[1]).toMatchObject({ attempts: 1, status: 'pending' })
  })

  it('loads persisted items before acting and tolerates broken storage', async () => {
    const persisted = {
      clientId: C1,
      conversationId: CONVERSATION_ID,
      input: input(C1, 'from disk'),
      attempts: 2,
      lastError: 'net',
      status: 'sending',
      createdAt: '2026-09-03T11:00:00.000Z',
    }
    const { send, storage, outbox } = setup({}, [persisted, { junk: true }])
    storage.failWrites = true
    await outbox.enqueue(input(C2))
    expect(outbox.state().items.map((i) => i.clientId)).toEqual([C1, C2])
    expect(outbox.state().items[0]?.status).toBe('pending')
    await expect(outbox.flush()).resolves.toEqual({ sent: 2, failed: 0, deferred: 0 })
    expect(send.mock.calls.map(([item]) => item.input.text)).toEqual(['from disk', 'hi'])
  })

  it('sends an item enqueued while a flush is winding down', async () => {
    const online = vi.fn(() => true)
    let release: () => void = () => undefined
    const { send, outbox } = setup({ autoFlush: true, isOnline: online })
    send.mockImplementationOnce(
      (item) =>
        new Promise<MessageDto>((resolve) => {
          release = () => resolve(serverMessage(item))
        }),
    )
    await outbox.enqueue(input(C1))
    await flushPromises()
    expect(outbox.state().flushing).toBe(true)
    // Connectivity blinks exactly when the running pass re-checks it after C1.
    online.mockReturnValueOnce(true) // enqueue's own check
    online.mockReturnValueOnce(false) // the pass's loop check
    const optimistic = await outbox.enqueue(input(C2))
    expect(optimistic.status).toBe('pending')
    release()
    await flushPromises()
    await flushPromises()
    expect(send.mock.calls.map(([item]) => item.clientId)).toEqual([C1, C2])
    expect(outbox.state().items).toEqual([])
    expect(outbox.state().flushing).toBe(false)
  })

  it('sends an item retried while a flush is winding down', async () => {
    const online = vi.fn(() => true)
    const { send, outbox } = setup({ isOnline: online })
    send.mockRejectedValueOnce(new EarthError('blocked'))
    await outbox.enqueue(input(C1))
    await expect(outbox.flush()).resolves.toEqual({ sent: 0, failed: 1, deferred: 0 })
    let release: () => void = () => undefined
    send.mockImplementationOnce(
      (item) =>
        new Promise<MessageDto>((resolve) => {
          release = () => resolve(serverMessage(item))
        }),
    )
    await outbox.enqueue(input(C2))
    const inFlight = outbox.flush()
    await flushPromises()
    online.mockReturnValueOnce(false)
    const retried = outbox.retry(C1)
    await flushPromises()
    release()
    await expect(inFlight).resolves.toEqual({ sent: 1, failed: 0, deferred: 1 })
    await expect(retried).resolves.toEqual({ sent: 1, failed: 0, deferred: 0 })
    expect(send.mock.calls.map(([item]) => [item.clientId, item.attempts])).toEqual([
      [C1, 0],
      [C2, 0],
      [C1, 0],
    ])
    expect(outbox.state().items).toEqual([])
  })

  it('retrying while the running pass already reached the item does not send it twice', async () => {
    const { send, outbox } = setup()
    send.mockRejectedValueOnce(new EarthError('blocked'))
    await outbox.enqueue(input(C1))
    await outbox.flush()
    let release: () => void = () => undefined
    send.mockImplementationOnce(
      (item) =>
        new Promise<MessageDto>((resolve) => {
          release = () => resolve(serverMessage(item))
        }),
    )
    await outbox.enqueue(input(C2))
    const inFlight = outbox.flush()
    await flushPromises()
    // C1 is pending again while the pass is still on C2, so the pass itself picks it up.
    const retried = outbox.retry(C1)
    await flushPromises()
    release()
    await expect(inFlight).resolves.toEqual({ sent: 2, failed: 0, deferred: 0 })
    await expect(retried).resolves.toEqual({ sent: 2, failed: 0, deferred: 0 })
    expect(send.mock.calls.map(([item]) => item.clientId)).toEqual([C1, C2, C1])
  })

  it('re-enqueueing a clientId that is mid-send never sends it twice', async () => {
    let release: () => void = () => undefined
    const { send, outbox } = setup({ autoFlush: true })
    send.mockImplementationOnce(
      (item) =>
        new Promise<MessageDto>((resolve) => {
          release = () => resolve(serverMessage(item))
        }),
    )
    await outbox.enqueue(input(C1, 'first'))
    await flushPromises()
    expect(outbox.state().items[0]?.status).toBe('sending')
    const again = await outbox.enqueue(input(C1, 'second'))
    expect(again.text).toBe('first')
    expect(again.status).toBe('pending')
    release()
    await flushPromises()
    await flushPromises()
    expect(send).toHaveBeenCalledTimes(1)
    expect(outbox.state().items).toEqual([])
  })

  it('removes items and unsubscribes listeners', async () => {
    const { outbox } = setup()
    const listener = vi.fn()
    const unsubscribe = outbox.subscribe(listener)
    await outbox.enqueue(input(C1))
    expect(listener).toHaveBeenCalled()
    listener.mockClear()
    unsubscribe()
    await outbox.remove(C1)
    await outbox.remove(C1)
    expect(outbox.state().items).toEqual([])
    expect(listener).not.toHaveBeenCalled()
  })
})
