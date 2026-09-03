import { type MessageDto, asConversationId, asHumanId, asMessageId } from '@earth/domain'
import { describe, expect, it, vi } from 'vitest'

import { REALTIME_TABLES, type RealtimeSubscriptionStatus } from './channel'
import {
  type MessageChange,
  type ReactionChangeEvent,
  type SubscribeConversationOptions,
  messageRowToDto,
  normalizeIsoTimestamp,
  reactionRowToChange,
  subscribeConversation,
} from './conversation'
import { createFakeClock, flushPromises } from './testing/fake-clock'
import { createFakeSupabase } from './testing/fake-supabase'
import { createRecordingDiagnostics } from './testing/fakes'

const CONVERSATION_ID = asConversationId('11111111-1111-4111-8111-111111111111')
const OTHER_CONVERSATION_ID = asConversationId('11111111-1111-4111-8111-222222222222')
const HUMAN_ID = asHumanId('22222222-2222-4222-8222-222222222222')
const M1 = '33333333-3333-4333-8333-333333333331'
const M2 = '33333333-3333-4333-8333-333333333332'
const M3 = '33333333-3333-4333-8333-333333333333'
const M4 = '33333333-3333-4333-8333-333333333334'
const M5 = '33333333-3333-4333-8333-333333333335'
const ISO = '2026-09-03T12:00:00.000Z'

function message(id: string, overrides: Partial<MessageDto> = {}): MessageDto {
  return {
    id: asMessageId(id),
    conversationId: CONVERSATION_ID,
    senderHumanId: HUMAN_ID,
    type: 'text',
    text: 'hi',
    payload: {},
    replyToMessageId: null,
    createdAt: ISO,
    editedAt: null,
    deletedAt: null,
    clientId: null,
    reactions: [],
    ...overrides,
  }
}

function row(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    conversation_id: CONVERSATION_ID,
    sender_human_id: HUMAN_ID,
    type: 'text',
    text: 'hi',
    payload: {},
    reply_to_message_id: null,
    created_at: '2026-09-03T12:00:00.123456+00:00',
    edited_at: null,
    deleted_at: null,
    client_id: null,
    ...overrides,
  }
}

function setup(overrides: Partial<SubscribeConversationOptions> = {}) {
  const supabase = createFakeSupabase()
  const clock = createFakeClock()
  const diagnostics = createRecordingDiagnostics()
  const fetchSince = vi.fn(async (_afterId: unknown): Promise<MessageDto[]> => [])
  const received: Array<[MessageDto, MessageChange]> = []
  const reactions: ReactionChangeEvent[] = []
  const statuses: RealtimeSubscriptionStatus[] = []
  const subscription = subscribeConversation({
    supabase,
    conversationId: CONVERSATION_ID,
    fetchSince,
    onMessage: (m, change) => received.push([m, change]),
    onReaction: (event) => reactions.push(event),
    onStatus: (status) => statuses.push(status),
    diagnostics,
    clock,
    ...overrides,
  })
  return { supabase, clock, diagnostics, fetchSince, received, reactions, statuses, subscription }
}

describe('messageRowToDto', () => {
  it('maps a snake_case row to a MessageDto without reactions', () => {
    const dto = messageRowToDto(row(M1, { client_id: '44444444-4444-4444-8444-444444444444' }))
    expect(dto).toEqual(
      message(M1, {
        createdAt: '2026-09-03T12:00:00.123456+00:00',
        clientId: '44444444-4444-4444-8444-444444444444',
      }),
    )
  })

  it('normalises Postgres text timestamps', () => {
    expect(normalizeIsoTimestamp('2026-09-03 12:00:00.5+00')).toBe('2026-09-03T12:00:00.5+00:00')
    expect(normalizeIsoTimestamp('2026-09-03T12:00:00')).toBe('2026-09-03T12:00:00Z')
    expect(normalizeIsoTimestamp('2026-09-03T12:00:00Z')).toBe('2026-09-03T12:00:00Z')
    expect(normalizeIsoTimestamp(null)).toBeNull()
    const dto = messageRowToDto(row(M1, { created_at: '2026-09-03 12:00:00+00' }))
    expect(dto?.createdAt).toBe('2026-09-03T12:00:00+00:00')
  })

  it('rejects malformed rows', () => {
    expect(messageRowToDto({})).toBeNull()
    expect(messageRowToDto(row(M1, { type: 'bogus' }))).toBeNull()
    expect(messageRowToDto(row('not-a-uuid'))).toBeNull()
  })
})

describe('reactionRowToChange', () => {
  it('maps and validates reaction rows', () => {
    expect(
      reactionRowToChange({ message_id: M1, human_id: HUMAN_ID, reaction: '🔥' }, 'added'),
    ).toEqual({ messageId: M1, humanId: HUMAN_ID, reaction: '🔥', change: 'added' })
    expect(
      reactionRowToChange({ message_id: M1, human_id: HUMAN_ID, reaction: '' }, 'added'),
    ).toBeNull()
    expect(
      reactionRowToChange({ message_id: 'x', human_id: HUMAN_ID, reaction: '🔥' }, 'removed'),
    ).toBeNull()
  })

  it('drops rows that name another conversation when one is expected', () => {
    const base = { message_id: M1, human_id: HUMAN_ID, reaction: '🔥' }
    expect(
      reactionRowToChange(
        { ...base, conversation_id: OTHER_CONVERSATION_ID },
        'added',
        CONVERSATION_ID,
      ),
    ).toBeNull()
    expect(
      reactionRowToChange({ ...base, conversation_id: CONVERSATION_ID }, 'added', CONVERSATION_ID),
    ).not.toBeNull()
    // A row without the column (older payloads) is still accepted.
    expect(reactionRowToChange(base, 'removed', CONVERSATION_ID)).not.toBeNull()
  })
})

describe('subscribeConversation — realtime path', () => {
  it('subscribes to messages and reactions and delivers mapped rows', () => {
    const { supabase, fetchSince, received, reactions, subscription } = setup()
    const channel = supabase.latest()
    expect(channel.topic).toBe(`conversation:${CONVERSATION_ID}:changes`)
    expect(channel.postgresBindings.map((b) => b.filter)).toEqual([
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${CONVERSATION_ID}`,
      },
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'messages',
        filter: `conversation_id=eq.${CONVERSATION_ID}`,
      },
      {
        event: '*',
        schema: 'public',
        table: 'message_reactions',
        filter: `conversation_id=eq.${CONVERSATION_ID}`,
      },
    ])

    channel.emitStatus('SUBSCRIBED')
    expect(subscription.mode()).toBe('realtime')
    expect(fetchSince).not.toHaveBeenCalled()

    channel.emitChange(REALTIME_TABLES.messages, 'INSERT', row(M1))
    channel.emitChange(REALTIME_TABLES.messages, 'INSERT', row(M1))
    channel.emitChange(
      REALTIME_TABLES.messages,
      'UPDATE',
      row(M1, { text: 'edited', edited_at: ISO }),
    )
    channel.emitChange(REALTIME_TABLES.messageReactions, 'INSERT', {
      message_id: M1,
      human_id: HUMAN_ID,
      reaction: '❤️',
    })
    channel.emitChange(REALTIME_TABLES.messageReactions, 'DELETE', {
      message_id: M1,
      human_id: HUMAN_ID,
      reaction: '❤️',
    })
    channel.emitChange(REALTIME_TABLES.messageReactions, 'UPDATE', {
      message_id: M1,
      human_id: HUMAN_ID,
      reaction: '❤️',
    })

    expect(received.map(([m, change]) => [m.id, change, m.text])).toEqual([
      [M1, 'inserted', 'hi'],
      [M1, 'updated', 'edited'],
    ])
    expect(received[1]?.[0].editedAt).toBe(ISO)
    expect(reactions.map((r) => r.change)).toEqual(['added', 'removed'])
    expect(subscription.lastSeenMessageId()).toBe(M1)
  })

  it('ignores rows from other conversations and catches up on unparsable rows', async () => {
    const { supabase, fetchSince, received, reactions } = setup()
    const channel = supabase.latest()
    channel.emitStatus('SUBSCRIBED')
    channel.emitChange(
      REALTIME_TABLES.messages,
      'INSERT',
      row(M1, { conversation_id: OTHER_CONVERSATION_ID }),
    )
    channel.emitChange(REALTIME_TABLES.messageReactions, 'INSERT', {
      message_id: M1,
      human_id: HUMAN_ID,
      reaction: '🔥',
      conversation_id: OTHER_CONVERSATION_ID,
    })
    channel.emitChange(REALTIME_TABLES.messageReactions, 'DELETE', {
      message_id: M2,
      human_id: HUMAN_ID,
      reaction: '🔥',
      conversation_id: CONVERSATION_ID,
    })
    expect(received).toHaveLength(0)
    expect(reactions.map((r) => [r.messageId, r.change])).toEqual([[M2, 'removed']])

    fetchSince.mockResolvedValueOnce([message(M2)])
    channel.emitChange(REALTIME_TABLES.messages, 'INSERT', { id: M2 })
    await flushPromises()
    expect(fetchSince).toHaveBeenCalledWith(null)
    expect(received.map(([m]) => m.id)).toEqual([M2])
  })

  it('does not move the polling cursor for an update to a message it has not seen', async () => {
    const { supabase, fetchSince, received, subscription } = setup({
      lastSeenMessageId: asMessageId(M1),
    })
    const channel = supabase.latest()
    channel.emitStatus('SUBSCRIBED')
    await flushPromises()
    channel.emitChange(REALTIME_TABLES.messages, 'UPDATE', row(M3, { text: 'edited' }))
    expect(received.map(([m, change]) => [m.id, change])).toEqual([[M3, 'updated']])
    expect(subscription.lastSeenMessageId()).toBe(M1)
    channel.emitStatus('CHANNEL_ERROR')
    await flushPromises()
    expect(fetchSince).toHaveBeenLastCalledWith(M1)
  })

  it('catches up once on join when the caller already holds messages', async () => {
    const { supabase, fetchSince, received } = setup({ lastSeenMessageId: asMessageId(M1) })
    fetchSince.mockResolvedValueOnce([message(M2)])
    supabase.latest().emitStatus('SUBSCRIBED')
    await flushPromises()
    expect(fetchSince).toHaveBeenCalledTimes(1)
    expect(fetchSince).toHaveBeenCalledWith(M1)
    expect(received.map(([m]) => m.id)).toEqual([M2])
  })
})

describe('subscribeConversation — polling fallback', () => {
  it('falls back after the join timeout, polls every 2 s and recovers', async () => {
    const { supabase, clock, diagnostics, fetchSince, subscription, statuses } = setup()
    const first = supabase.latest()

    await clock.advanceAsync(4_999)
    expect(subscription.mode()).toBe('realtime')
    expect(fetchSince).not.toHaveBeenCalled()

    await clock.advanceAsync(1)
    expect(subscription.mode()).toBe('polling')
    expect(first.removed).toBe(true)
    expect(fetchSince).toHaveBeenCalledTimes(1)
    expect(diagnostics.events).toEqual([
      {
        kind: 'realtime_fallback',
        channel: 'conversation',
        conversationId: CONVERSATION_ID,
        attempt: 1,
        reason: 'join_timeout',
        code: 'join_timeout',
      },
    ])

    await clock.advanceAsync(2_000)
    expect(fetchSince).toHaveBeenCalledTimes(2)
    await clock.advanceAsync(2_000)
    expect(fetchSince).toHaveBeenCalledTimes(3)

    // The channel was re-created after 1 s of backoff; joining it ends polling.
    expect(supabase.channels).toHaveLength(2)
    const second = supabase.latest()
    second.emitStatus('SUBSCRIBED')
    await flushPromises()
    expect(subscription.mode()).toBe('realtime')
    expect(diagnostics.kinds()).toEqual(['realtime_fallback', 'realtime_recovered'])
    // One final catch-up closes the gap, then no more polls.
    expect(fetchSince).toHaveBeenCalledTimes(4)
    await clock.advanceAsync(10_000)
    expect(fetchSince).toHaveBeenCalledTimes(4)
    expect(statuses.at(-1)).toMatchObject({ mode: 'realtime', subscribed: true, failures: 0 })
  })

  it('emits realtime_fallback once across repeated channel errors with growing backoff', async () => {
    const { supabase, clock, diagnostics } = setup()
    supabase.latest().emitStatus('CHANNEL_ERROR', new Error('down'))
    await clock.advanceAsync(1_000)
    supabase.latest().emitStatus('CHANNEL_ERROR')
    await clock.advanceAsync(2_000)
    supabase.latest().emitStatus('CHANNEL_ERROR')
    expect(supabase.channels).toHaveLength(3)
    expect(diagnostics.kinds()).toEqual(['realtime_fallback'])
    expect(diagnostics.events[0]).toMatchObject({
      reason: 'CHANNEL_ERROR: down',
      code: 'CHANNEL_ERROR',
    })
  })

  it('dedupes polled messages by id and preserves server order', async () => {
    const { supabase, clock, fetchSince, received, subscription } = setup({
      lastSeenMessageId: asMessageId(M1),
    })
    fetchSince.mockResolvedValueOnce([message(M2), message(M3)])
    fetchSince.mockResolvedValueOnce([message(M3), message(M2)])
    supabase.latest().emitStatus('CHANNEL_ERROR')
    await flushPromises()
    expect(fetchSince).toHaveBeenNthCalledWith(1, M1)
    await clock.advanceAsync(2_000)
    expect(fetchSince).toHaveBeenNthCalledWith(2, M3)
    expect(received.map(([m, change]) => [m.id, change])).toEqual([
      [M2, 'inserted'],
      [M3, 'inserted'],
    ])
    expect(subscription.lastSeenMessageId()).toBe(M3)
  })

  it('reports a failing poll once per streak', async () => {
    const { supabase, clock, diagnostics, fetchSince } = setup()
    fetchSince.mockRejectedValueOnce(new Error('offline'))
    fetchSince.mockRejectedValueOnce(new Error('offline'))
    supabase.latest().emitStatus('TIMED_OUT')
    await clock.advanceAsync(2_000)
    expect(fetchSince).toHaveBeenCalledTimes(2)
    expect(diagnostics.kinds()).toEqual(['realtime_fallback', 'realtime_poll_failed'])
    expect(diagnostics.events[1]).toMatchObject({
      channel: 'conversation',
      attempt: 1,
      reason: 'offline',
    })
    await clock.advanceAsync(2_000)
    expect(fetchSince).toHaveBeenCalledTimes(3)
    fetchSince.mockRejectedValueOnce(new Error('offline again'))
    await clock.advanceAsync(2_000)
    expect(diagnostics.kinds()).toEqual([
      'realtime_fallback',
      'realtime_poll_failed',
      'realtime_poll_failed',
    ])
  })

  it('delivers each message once across realtime → polling → realtime with overlapping fetches', async () => {
    const { supabase, clock, diagnostics, fetchSince, received, subscription } = setup()
    const first = supabase.latest()
    first.emitStatus('SUBSCRIBED')
    // Realtime can deliver out of commit order; the cursor follows the last delivered row.
    first.emitChange(REALTIME_TABLES.messages, 'INSERT', row(M2))
    first.emitChange(REALTIME_TABLES.messages, 'INSERT', row(M1))
    expect(subscription.lastSeenMessageId()).toBe(M1)

    fetchSince.mockResolvedValueOnce([message(M2), message(M3)])
    first.emitStatus('CHANNEL_ERROR')
    await flushPromises()
    expect(fetchSince).toHaveBeenNthCalledWith(1, M1)
    expect(received.map(([m]) => m.id)).toEqual([M2, M1, M3])

    // The second poll is slow; the retry channel joins while it is in flight.
    let resolvePoll: (messages: MessageDto[]) => void = () => undefined
    fetchSince.mockImplementationOnce(
      () =>
        new Promise<MessageDto[]>((resolve) => {
          resolvePoll = resolve
        }),
    )
    await clock.advanceAsync(2_000)
    expect(fetchSince).toHaveBeenNthCalledWith(2, M3)
    const second = supabase.latest()
    expect(second).not.toBe(first)
    second.emitStatus('SUBSCRIBED')
    await flushPromises()
    expect(subscription.mode()).toBe('realtime')
    // Realtime delivers M4 before the poll returns it; the recovery catch-up runs after the poll.
    second.emitChange(REALTIME_TABLES.messages, 'INSERT', row(M4))
    fetchSince.mockResolvedValueOnce([])
    resolvePoll([message(M4), message(M5)])
    await flushPromises()
    expect(fetchSince).toHaveBeenNthCalledWith(3, M5)
    // A late realtime copy of a polled message is deduplicated too.
    second.emitChange(REALTIME_TABLES.messages, 'INSERT', row(M5))
    expect(received.map(([m]) => m.id)).toEqual([M2, M1, M3, M4, M5])
    expect(fetchSince).toHaveBeenCalledTimes(3)
    await clock.advanceAsync(10_000)
    expect(fetchSince).toHaveBeenCalledTimes(3)
    expect(clock.pending()).toBe(0)
    expect(diagnostics.kinds()).toEqual(['realtime_fallback', 'realtime_recovered'])
  })

  it('keeps exactly one poll timer across rapid flapping', async () => {
    const { supabase, clock, fetchSince, subscription } = setup({
      lastSeenMessageId: asMessageId(M1),
    })
    supabase.latest().emitStatus('CHANNEL_ERROR')
    await flushPromises()
    expect(fetchSince).toHaveBeenCalledTimes(1)
    // Re-subscribe timer (1 s) + poll timer (2 s).
    expect(clock.pending()).toBe(2)
    await clock.advanceAsync(1_000)
    const second = supabase.latest()
    second.emitStatus('SUBSCRIBED')
    await flushPromises()
    expect(fetchSince).toHaveBeenCalledTimes(2)
    // Join timer and poll timer are both gone.
    expect(clock.pending()).toBe(0)
    second.emitStatus('CHANNEL_ERROR')
    await flushPromises()
    expect(fetchSince).toHaveBeenCalledTimes(3)
    expect(clock.pending()).toBe(2)
    await clock.advanceAsync(2_000)
    expect(fetchSince).toHaveBeenCalledTimes(4)
    expect(clock.pending()).toBe(2)
    subscription.unsubscribe()
    expect(clock.pending()).toBe(0)
  })

  it('ignores a late SUBSCRIBED from the channel it already gave up on', async () => {
    const { supabase, clock, diagnostics, fetchSince, subscription } = setup()
    const first = supabase.latest()
    await clock.advanceAsync(5_000)
    expect(subscription.mode()).toBe('polling')
    first.emitStatus('SUBSCRIBED')
    await flushPromises()
    expect(subscription.mode()).toBe('polling')
    expect(diagnostics.kinds()).toEqual(['realtime_fallback'])
    await clock.advanceAsync(2_000)
    expect(fetchSince).toHaveBeenCalledTimes(2)
  })

  it('drops fetch results that resolve after unsubscribe', async () => {
    const { supabase, fetchSince, received, subscription } = setup()
    let resolvePoll: (messages: MessageDto[]) => void = () => undefined
    fetchSince.mockImplementationOnce(
      () =>
        new Promise<MessageDto[]>((resolve) => {
          resolvePoll = resolve
        }),
    )
    supabase.latest().emitStatus('CHANNEL_ERROR')
    await flushPromises()
    subscription.unsubscribe()
    resolvePoll([message(M1)])
    await flushPromises()
    expect(received).toEqual([])
    expect(subscription.lastSeenMessageId()).toBeNull()
  })

  it('coalesces overlapping catch-ups', async () => {
    const { subscription, fetchSince } = setup()
    let resolveFetch: (messages: MessageDto[]) => void = () => undefined
    fetchSince.mockImplementationOnce(
      () =>
        new Promise<MessageDto[]>((resolve) => {
          resolveFetch = resolve
        }),
    )
    const first = subscription.refresh()
    const second = subscription.refresh()
    const third = subscription.refresh()
    expect(second).toBe(first)
    expect(third).toBe(first)
    resolveFetch([])
    await first
    expect(fetchSince).toHaveBeenCalledTimes(2)
  })

  it('unsubscribe stops polling, removes the channel and ignores late events', async () => {
    const { supabase, clock, fetchSince, received, subscription } = setup()
    supabase.latest().emitStatus('CLOSED')
    await flushPromises()
    expect(subscription.mode()).toBe('polling')
    subscription.unsubscribe()
    subscription.unsubscribe()
    expect(clock.pending()).toBe(0)
    expect(supabase.active()).toHaveLength(0)
    await clock.advanceAsync(10_000)
    expect(fetchSince).toHaveBeenCalledTimes(1)
    supabase.latest().emitChange(REALTIME_TABLES.messages, 'INSERT', row(M1))
    expect(received).toHaveLength(0)
    await expect(subscription.refresh()).resolves.toBeUndefined()
    expect(fetchSince).toHaveBeenCalledTimes(1)
  })
})
