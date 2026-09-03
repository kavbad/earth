import { fixtures } from '@earth/api/testing'
import {
  type ConversationMemberDto,
  ConversationMemberDtoSchema,
  ConversationSummaryDtoSchema,
  MessageDtoSchema,
  asHumanId,
  asMessageId,
} from '@earth/domain'
import { describe, expect, it } from 'vitest'

import type { ChatMessage } from './messages'
import {
  isUnread,
  mergeReadPointers,
  messageIdToMarkRead,
  seenByFor,
  seenByNames,
  totalUnread,
  withUnreadCleared,
} from './read'

const XAVIER = asHumanId(fixtures.IDS.xavier)
const MAYA = asHumanId(fixtures.IDS.maya)
const KAVON = asHumanId(fixtures.IDS.kavon)

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
}

function message(n: number, sender = XAVIER, status: ChatMessage['status'] = 'sent'): ChatMessage {
  return {
    ...MessageDtoSchema.parse(
      fixtures.messageDto({
        id: uuid(n),
        senderHumanId: sender,
        createdAt: new Date(Date.UTC(2026, 8, 3, 12, n)).toISOString(),
        clientId: null,
        reactions: [],
      }),
    ),
    status,
  }
}

function member(
  humanId: string,
  displayName: string,
  lastRead: string | null,
): ConversationMemberDto {
  return ConversationMemberDtoSchema.parse({
    humanId,
    displayName,
    handle: displayName.toLowerCase(),
    avatarUrl: null,
    joinedAt: fixtures.AT,
    lastReadMessageId: lastRead,
  })
}

describe('messageIdToMarkRead', () => {
  const messages = [message(1, MAYA), message(2, MAYA), message(3, XAVIER, 'pending')]

  it('marks the newest acknowledged message when visible and online', () => {
    expect(messageIdToMarkRead({ messages, markedId: null, visible: true, online: true })).toBe(
      uuid(2),
    )
  })

  it('does nothing when already marked, hidden, offline or empty', () => {
    expect(
      messageIdToMarkRead({
        messages,
        markedId: asMessageId(uuid(2)),
        visible: true,
        online: true,
      }),
    ).toBeNull()
    expect(
      messageIdToMarkRead({ messages, markedId: null, visible: false, online: true }),
    ).toBeNull()
    expect(
      messageIdToMarkRead({ messages, markedId: null, visible: true, online: false }),
    ).toBeNull()
    expect(
      messageIdToMarkRead({ messages: [], markedId: null, visible: true, online: true }),
    ).toBeNull()
  })
})

describe('seenByFor (spec §55)', () => {
  const members = [
    member(XAVIER, 'Xavier', uuid(4)),
    member(MAYA, 'Maya', uuid(2)),
    member(KAVON, 'Kavon', null),
  ]
  const messages = [message(1, XAVIER), message(2, XAVIER), message(3, MAYA), message(4, XAVIER)]

  it("names the viewer's newest message that someone else read", () => {
    const seen = seenByFor(messages, mergeReadPointers(members, []), XAVIER)
    expect(seen).toEqual({ messageId: uuid(2), humanIds: [MAYA] })
    expect(seenByNames(seen?.humanIds ?? [], members)).toBe('Maya')
  })

  it('prefers fresher read receipts over member pointers and collapses many names', () => {
    const pointers = mergeReadPointers(members, [
      { humanId: MAYA, lastReadMessageId: asMessageId(uuid(4)) },
      { humanId: KAVON, lastReadMessageId: asMessageId(uuid(4)) },
    ])
    const seen = seenByFor(messages, pointers, XAVIER)
    expect(seen?.messageId).toBe(uuid(4))
    expect(seen?.humanIds).toEqual([MAYA, KAVON])
    expect(seenByNames(seen?.humanIds ?? [], members)).toBe('Maya + Kavon')
    const three = seenByNames([MAYA, KAVON, XAVIER], members)
    expect(three).toBe('Maya, Kavon + 1')
  })

  it('is null for visitors, for unread messages and for pointers outside the loaded window', () => {
    expect(seenByFor(messages, mergeReadPointers(members, []), null)).toBeNull()
    expect(seenByFor(messages, [{ humanId: MAYA, lastReadMessageId: null }], XAVIER)).toBeNull()
    expect(
      seenByFor(messages, [{ humanId: MAYA, lastReadMessageId: asMessageId(uuid(99)) }], XAVIER),
    ).toBeNull()
    // Maya read only her own message; nothing of Xavier's after it was seen by anyone.
    expect(
      seenByFor(
        [message(1, MAYA), message(2, XAVIER)],
        [{ humanId: MAYA, lastReadMessageId: asMessageId(uuid(1)) }],
        XAVIER,
      ),
    ).toBeNull()
  })
})

describe('unread state', () => {
  const summary = (unreadCount: number, id: string = fixtures.IDS.conversation) =>
    ConversationSummaryDtoSchema.parse(fixtures.conversationSummary({ id, unreadCount }))

  it('reads and clears unread counts on the list cache', () => {
    const page = { conversations: [summary(3), summary(2, uuid(8))], nextCursor: null }
    expect(isUnread(summary(3))).toBe(true)
    expect(isUnread(summary(0))).toBe(false)
    expect(totalUnread(page.conversations)).toBe(5)
    const cleared = withUnreadCleared(page, fixtures.IDS.conversation)
    expect(cleared.conversations.map((c) => c.unreadCount)).toEqual([0, 2])
    // Untouched rows keep their identity so memoised rows do not re-render.
    expect(cleared.conversations[1]).toBe(page.conversations[1])
  })
})
