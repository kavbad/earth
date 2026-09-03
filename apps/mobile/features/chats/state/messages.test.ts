import { fixtures } from '@earth/api/testing'
import {
  type HumanId,
  type MessageDto,
  MessageDtoSchema,
  asHumanId,
  asMessageId,
} from '@earth/domain'
import type { OptimisticMessage } from '@earth/realtime'
import { describe, expect, it } from 'vitest'

import {
  type ChatMessage,
  GROUP_MAX_MESSAGES,
  INITIAL_MESSAGES_STATE,
  type MessagesState,
  annotateMessages,
  compareMessages,
  dayLabel,
  invertRows,
  messagesReducer,
  newestSentMessageId,
  oldestSentMessageId,
} from './messages'

const XAVIER = asHumanId(fixtures.IDS.xavier)
const MAYA = asHumanId(fixtures.IDS.maya)

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

function at(minutes: number): string {
  return new Date(Date.UTC(2026, 8, 3, 12, minutes, 0)).toISOString()
}

function server(
  n: number,
  overrides: Partial<Omit<MessageDto, 'id'>> & { readonly minute?: number } = {},
): MessageDto {
  const { minute, ...rest } = overrides
  return MessageDtoSchema.parse(
    fixtures.messageDto({
      id: uuid(n),
      senderHumanId: MAYA,
      createdAt: at(minute ?? n),
      clientId: null,
      reactions: [],
      ...rest,
    }),
  )
}

function optimistic(
  clientId: string,
  status: OptimisticMessage['status'] = 'pending',
  minute = 90,
): OptimisticMessage {
  return {
    id: asMessageId(clientId),
    conversationId: fixtures.IDS.conversation as MessageDto['conversationId'],
    senderHumanId: XAVIER,
    type: 'text',
    text: 'On my way',
    payload: {},
    replyToMessageId: null,
    createdAt: at(minute),
    editedAt: null,
    deletedAt: null,
    clientId,
    reactions: [],
    status,
  }
}

function reduce(actions: Parameters<typeof messagesReducer>[1][]): MessagesState {
  return actions.reduce(messagesReducer, INITIAL_MESSAGES_STATE)
}

function ids(state: MessagesState): string[] {
  return state.messages.map((message) => message.id)
}

describe('messagesReducer ordering', () => {
  it('orders a newest-first page ascending by server time and keeps the cursor', () => {
    const state = reduce([
      {
        type: 'page',
        messages: [server(3), server(2), server(1)],
        nextCursor: 'older',
        initial: true,
      },
    ])
    expect(ids(state)).toEqual([uuid(1), uuid(2), uuid(3)])
    expect(state.nextCursor).toBe('older')
    expect(state.loaded).toBe(true)
  })

  it('prepends an older page without duplicating overlapping rows', () => {
    const state = reduce([
      { type: 'page', messages: [server(4), server(3)], nextCursor: 'c1', initial: true },
      {
        type: 'page',
        messages: [server(3), server(2), server(1)],
        nextCursor: null,
        initial: false,
      },
    ])
    expect(ids(state)).toEqual([uuid(1), uuid(2), uuid(3), uuid(4)])
    expect(state.nextCursor).toBeNull()
  })

  it('breaks createdAt ties by id and sorts pending messages after every sent one', () => {
    const a: ChatMessage = { ...server(1, { minute: 5 }), status: 'sent' }
    const b: ChatMessage = { ...server(2, { minute: 5 }), status: 'sent' }
    const pending: ChatMessage = { ...optimistic(uuid(9), 'pending', 1), status: 'pending' }
    expect(compareMessages(a, b)).toBeLessThan(0)
    expect(compareMessages(b, a)).toBeGreaterThan(0)
    // The optimistic row has an earlier local timestamp (clock skew) but still renders last.
    expect(compareMessages(pending, b)).toBeGreaterThan(0)
  })

  it('inserts realtime messages in server order regardless of arrival order', () => {
    const state = reduce([
      { type: 'page', messages: [server(1)], nextCursor: null, initial: true },
      { type: 'received', message: server(3), change: 'inserted' },
      { type: 'received', message: server(2), change: 'inserted' },
    ])
    expect(ids(state)).toEqual([uuid(1), uuid(2), uuid(3)])
  })

  it('ignores a duplicate realtime insert', () => {
    const state = reduce([
      { type: 'page', messages: [server(1)], nextCursor: null, initial: true },
      { type: 'received', message: server(1), change: 'inserted' },
    ])
    expect(ids(state)).toEqual([uuid(1)])
  })
})

describe('messagesReducer optimistic sends (spec §53–§54, §108)', () => {
  const clientId = uuid(77)

  it('renders the outbox row as pending, then replaces it with the acknowledged DTO', () => {
    const acknowledged = server(5, { senderHumanId: XAVIER, clientId, text: 'On my way' })
    const state = reduce([
      { type: 'page', messages: [server(1)], nextCursor: null, initial: true },
      { type: 'outbox', messages: [optimistic(clientId)] },
    ])
    expect(ids(state)).toEqual([uuid(1), clientId])
    expect(state.messages[1]?.status).toBe('pending')
    const sent = messagesReducer(state, { type: 'sent', clientId, message: acknowledged })
    expect(ids(sent)).toEqual([uuid(1), uuid(5)])
    expect(sent.messages[1]?.status).toBe('sent')
  })

  it('lets the realtime echo replace the optimistic row and makes the later ack a no-op', () => {
    const acknowledged = server(5, { senderHumanId: XAVIER, clientId })
    const state = reduce([
      { type: 'page', messages: [], nextCursor: null, initial: true },
      { type: 'outbox', messages: [optimistic(clientId)] },
      { type: 'received', message: acknowledged, change: 'inserted' },
      { type: 'sent', clientId, message: acknowledged },
      // The outbox may still report the item for a tick after the ack.
      { type: 'outbox', messages: [optimistic(clientId)] },
    ])
    expect(ids(state)).toEqual([uuid(5)])
  })

  it('marks a failed item and drops it on discard', () => {
    const failed = reduce([
      { type: 'page', messages: [server(1)], nextCursor: null, initial: true },
      { type: 'outbox', messages: [optimistic(clientId)] },
      { type: 'outbox', messages: [optimistic(clientId, 'failed')] },
    ])
    expect(failed.messages[1]?.status).toBe('failed')
    const discarded = messagesReducer(failed, { type: 'discard', clientId })
    expect(ids(discarded)).toEqual([uuid(1)])
  })

  it('drops optimistic rows the outbox no longer holds and the server never acknowledged', () => {
    const state = reduce([
      { type: 'page', messages: [], nextCursor: null, initial: true },
      { type: 'outbox', messages: [optimistic(clientId)] },
      { type: 'outbox', messages: [] },
    ])
    expect(ids(state)).toEqual([])
  })

  it('keeps queued messages across an initial page reload', () => {
    const state = reduce([
      { type: 'outbox', messages: [optimistic(clientId)] },
      { type: 'page', messages: [server(1)], nextCursor: null, initial: true },
    ])
    expect(ids(state)).toEqual([uuid(1), clientId])
  })
})

describe('messagesReducer updates and reactions', () => {
  it('keeps held reactions when a realtime update carries none, and tombstones deletes', () => {
    const withReaction = server(1, { reactions: [{ reaction: '❤️', count: 2, reactedByMe: true }] })
    const edited = { ...server(1), text: 'edited', editedAt: at(30), reactions: [] }
    const state = reduce([
      { type: 'page', messages: [withReaction], nextCursor: null, initial: true },
      { type: 'received', message: edited, change: 'updated' },
    ])
    expect(state.messages[0]?.text).toBe('edited')
    expect(state.messages[0]?.reactions).toEqual([{ reaction: '❤️', count: 2, reactedByMe: true }])
    const deleted = messagesReducer(state, {
      type: 'deleted',
      messageId: asMessageId(uuid(1)),
      at: at(31),
    })
    expect(deleted.messages[0]?.deletedAt).toBe(at(31))
    expect(deleted.messages[0]?.text).toBeNull()
  })

  it('ignores an update for a message that was never loaded', () => {
    const state = reduce([
      { type: 'page', messages: [server(2)], nextCursor: 'more', initial: true },
      { type: 'received', message: server(1), change: 'updated' },
    ])
    expect(ids(state)).toEqual([uuid(2)])
  })

  it('applies a viewer toggle once even when its realtime echo follows', () => {
    const messageId = asMessageId(uuid(1))
    const toggled = reduce([
      { type: 'page', messages: [server(1)], nextCursor: null, initial: true },
      { type: 'toggleReaction', messageId, reaction: '👍' },
      {
        type: 'reaction',
        event: { messageId, humanId: XAVIER, reaction: '👍', change: 'added' },
        viewerHumanId: XAVIER,
      },
    ])
    expect(toggled.messages[0]?.reactions).toEqual([
      { reaction: '👍', count: 1, reactedByMe: true },
    ])
    const untoggled = reduce([
      {
        type: 'page',
        messages: [{ ...server(1), reactions: toggled.messages[0]?.reactions ?? [] }],
        nextCursor: null,
        initial: true,
      },
      { type: 'toggleReaction', messageId, reaction: '👍' },
      {
        type: 'reaction',
        event: { messageId, humanId: XAVIER, reaction: '👍', change: 'removed' },
        viewerHumanId: XAVIER,
      },
    ])
    expect(untoggled.messages[0]?.reactions).toEqual([])
  })

  it("counts other people's reactions without touching reactedByMe", () => {
    const messageId = asMessageId(uuid(1))
    const state = reduce([
      { type: 'page', messages: [server(1)], nextCursor: null, initial: true },
      {
        type: 'reaction',
        event: { messageId, humanId: MAYA, reaction: '❤️', change: 'added' },
        viewerHumanId: XAVIER,
      },
      {
        type: 'reaction',
        event: { messageId, humanId: MAYA, reaction: '❤️', change: 'added' },
        viewerHumanId: XAVIER,
      },
    ])
    expect(state.messages[0]?.reactions).toEqual([{ reaction: '❤️', count: 2, reactedByMe: false }])
  })
})

describe('newest / oldest sent ids', () => {
  it('skip optimistic rows', () => {
    const state = reduce([
      { type: 'page', messages: [server(2), server(1)], nextCursor: null, initial: true },
      { type: 'outbox', messages: [optimistic(uuid(9))] },
    ])
    expect(newestSentMessageId(state.messages)).toBe(uuid(2))
    expect(oldestSentMessageId(state.messages)).toBe(uuid(1))
    expect(newestSentMessageId([])).toBeNull()
  })
})

describe('annotateMessages grouping', () => {
  const now = new Date(Date.UTC(2026, 8, 3, 15, 0, 0))

  function rows(messages: readonly MessageDto[], viewer: HumanId | null = XAVIER) {
    return annotateMessages(
      messages.map((message) => ({ ...message, status: 'sent' as const })),
      viewer,
      now,
    )
  }

  it('groups one sender within five minutes and marks ownership and time on the last row', () => {
    const result = rows([
      server(1, { minute: 0 }),
      server(2, { minute: 2 }),
      server(3, { minute: 4 }),
      server(4, { minute: 20, senderHumanId: XAVIER }),
    ])
    expect(result.map((row) => row.position)).toEqual(['first', 'middle', 'last', 'single'])
    expect(result.map((row) => row.isMine)).toEqual([false, false, false, true])
    expect(result.map((row) => row.showTime)).toEqual([false, false, true, true])
  })

  it('never groups across senders, system rows, the five-minute gap or the group cap', () => {
    const result = rows([
      server(1, { minute: 0 }),
      server(2, { minute: 1, senderHumanId: XAVIER }),
      server(3, { minute: 2, type: 'system', text: 'Maya joined' }),
      server(4, { minute: 3 }),
      server(5, { minute: 9 }),
    ])
    expect(result.map((row) => row.position)).toEqual([
      'single',
      'single',
      'single',
      'single',
      'single',
    ])
    expect(result[2]?.showTime).toBe(false)

    const many = rows(
      Array.from({ length: GROUP_MAX_MESSAGES + 1 }, (_, index) =>
        server(index + 1, { minute: 0 }),
      ),
    )
    expect(many[GROUP_MAX_MESSAGES - 1]?.position).toBe('last')
    expect(many[GROUP_MAX_MESSAGES]?.position).toBe('single')
  })

  it('places a day label on the first row of each day only', () => {
    const yesterday = new Date(Date.UTC(2026, 8, 2, 12, 0, 0)).toISOString()
    const result = rows([
      server(1, { createdAt: yesterday }),
      server(2, { createdAt: yesterday }),
      server(3, { minute: 0 }),
    ])
    expect(result.map((row) => row.dayLabel !== null)).toEqual([true, false, true])
  })

  it('inverts rows for the inverted list, newest first, keeping each row intact', () => {
    const result = rows([server(1, { minute: 0 }), server(2, { minute: 1 })])
    const inverted = invertRows(result)
    expect(inverted.map((row) => row.message.id)).toEqual([uuid(2), uuid(1)])
    expect(inverted[1]?.dayLabel).not.toBeNull()
    expect(invertRows([])).toEqual([])
  })
})

describe('dayLabel', () => {
  const now = new Date(2026, 8, 3, 15, 0, 0)
  const local = (y: number, m: number, d: number) => new Date(y, m, d, 9, 0, 0).toISOString()

  it('says Today, Yesterday, a weekday, then a date', () => {
    expect(dayLabel(local(2026, 8, 3), now)).toBe('Today')
    expect(dayLabel(local(2026, 8, 2), now)).toBe('Yesterday')
    expect(dayLabel(local(2026, 8, 1), now)).toBe('Tue')
    expect(dayLabel(local(2026, 7, 1), now)).toBe('Aug 1')
    expect(dayLabel(local(2025, 7, 1), now)).toBe('Aug 1, 2025')
    expect(dayLabel('nope', now)).toBe('')
  })
})
