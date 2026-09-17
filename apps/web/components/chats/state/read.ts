/**
 * Read state (spec §55): one `last_read_message_id` per member, "Seen by X" on the viewer's own
 * messages, and the decision of when an open conversation marks itself read. Pure.
 */
import type {
  ConversationMemberDto,
  ConversationSummaryDto,
  HumanId,
  MessageId,
} from '@earth/domain'
import { namesWithPlus } from '@earth/ui'

import { type ChatMessage, newestSentMessageId } from './messages'

export interface ReadPointer {
  readonly humanId: HumanId
  readonly lastReadMessageId: MessageId | null
}

/** Debounce before `conversation_mark_read` fires for a newly visible newest message. */
export const MARK_READ_DEBOUNCE_MS = 400

export interface MarkReadInput {
  readonly messages: readonly ChatMessage[]
  /** The newest id already sent to `conversation_mark_read` in this session. */
  readonly markedId: MessageId | null
  /** The tab is visible and the conversation is on screen. */
  readonly visible: boolean
  readonly online: boolean
}

/** Which message id to mark read now, or `null` when nothing new is on screen. */
export function messageIdToMarkRead(input: MarkReadInput): MessageId | null {
  if (!input.visible || !input.online) return null
  const newest = newestSentMessageId(input.messages)
  if (newest === null || newest === input.markedId) return null
  return newest
}

/** Members' pointers with the fresher `conversation_read_receipts` answer on top. */
export function mergeReadPointers(
  members: readonly ConversationMemberDto[],
  receipts: readonly ReadPointer[],
): ReadPointer[] {
  const byHuman = new Map<HumanId, ReadPointer>()
  for (const member of members) {
    byHuman.set(member.humanId, {
      humanId: member.humanId,
      lastReadMessageId: member.lastReadMessageId,
    })
  }
  for (const receipt of receipts) byHuman.set(receipt.humanId, receipt)
  return [...byHuman.values()]
}

export interface SeenBy {
  readonly messageId: MessageId
  readonly humanIds: readonly HumanId[]
}

/**
 * The viewer's newest message that anyone else has read, with who read it — the single subtle
 * "Seen by" line of spec §55 (details on message action). `null` when nothing of theirs was seen.
 */
export function seenByFor(
  messages: readonly ChatMessage[],
  pointers: readonly ReadPointer[],
  viewerHumanId: HumanId | null,
): SeenBy | null {
  if (viewerHumanId === null) return null
  const indexById = new Map<string, number>()
  messages.forEach((message, index) => {
    if (message.status === 'sent') indexById.set(message.id, index)
  })
  const readers = pointers
    .filter((pointer) => pointer.humanId !== viewerHumanId && pointer.lastReadMessageId !== null)
    .map((pointer) => ({
      humanId: pointer.humanId,
      index: indexById.get(pointer.lastReadMessageId ?? '') ?? -1,
    }))
    .filter((reader) => reader.index >= 0)
  if (readers.length === 0) return null
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === undefined || message.status !== 'sent') continue
    if (message.senderHumanId !== viewerHumanId || message.type === 'system') continue
    const humanIds = readers.filter((reader) => reader.index >= index).map((r) => r.humanId)
    if (humanIds.length > 0) return { messageId: message.id, humanIds }
  }
  return null
}

/** `Maya` · `Maya + Xavier` · `Maya, Xavier + 2` for the "Seen by" line. */
export function seenByNames(
  humanIds: readonly HumanId[],
  members: readonly ConversationMemberDto[],
): string {
  const nameById = new Map(members.map((member) => [member.humanId, member.displayName]))
  const names = humanIds.map((id) => nameById.get(id) ?? '').filter((name) => name.length > 0)
  return namesWithPlus(names, { total: humanIds.length })
}

/** The chats-list cache after the viewer read a conversation: its unread count is zero. */
export function withUnreadCleared<
  T extends { readonly conversations: readonly ConversationSummaryDto[] },
>(page: T, conversationId: string): T {
  return {
    ...page,
    conversations: page.conversations.map((conversation) =>
      conversation.id === conversationId && conversation.unreadCount !== 0
        ? { ...conversation, unreadCount: 0 }
        : conversation,
    ),
  }
}

/** Whether a row shows the unread state (spec SCREEN 08). */
export function isUnread(conversation: Pick<ConversationSummaryDto, 'unreadCount'>): boolean {
  return conversation.unreadCount > 0
}

/** Total unread across loaded conversations (for a quiet count, never a red badge). */
export function totalUnread(conversations: readonly ConversationSummaryDto[]): number {
  return conversations.reduce((sum, conversation) => sum + conversation.unreadCount, 0)
}
