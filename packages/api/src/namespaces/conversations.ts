/**
 * `conversations` and `conversations.messages` (DB_API §2; spec PART VII).
 */
import {
  type ConversationCreateInput,
  ConversationCreateInputSchema,
  type ConversationDetailDto,
  type ConversationId,
  ConversationIdSchema,
  type ConversationMarkReadInput,
  ConversationMarkReadInputSchema,
  type ConversationSummaryDto,
  type HumanId,
  HumanIdSchema,
  MESSAGES_PAGE_SIZE,
  type MessageDto,
  type MessageEditInput,
  MessageEditInputSchema,
  type MessageId,
  MessageIdSchema,
  MessageSendInputSchema,
  type MessagesPageDto,
  type ReactionToggleInput,
  ReactionToggleInputSchema,
} from '@earth/domain'
import type { z } from 'zod'

import {
  type ConversationPrefsDto,
  type ConversationPrefsInput,
  ConversationPrefsInputSchema,
  type ConversationReadStateDto,
  type ConversationsListInput,
  ConversationsListInputSchema,
  type ConversationsPageDto,
  type MessagesListInput,
  MessagesListInputSchema,
  type MessagesSinceInput,
  MessagesSinceInputSchema,
  type ReadReceiptDto,
} from '../dto'
import { CALLS } from '../manifest'
import { type Transport, parseInput } from '../transport'

export type MessageSendInputLike = z.input<typeof MessageSendInputSchema>

export interface MessageReactionsNamespace {
  /** `message_reaction_toggle(message_id, reaction)`: the message with its updated reaction summaries. */
  toggle(input: ReactionToggleInput): Promise<MessageDto>
}

export interface MessagesNamespace {
  /** `messages_list(conversation_id, before_id, limit)`: keyset, newest first. */
  list(input: MessagesListInput): Promise<MessagesPageDto>
  /** `messages_since(conversation_id, after_id)`: ascending catch-up for the polling fallback. */
  since(input: MessagesSinceInput): Promise<MessageDto[]>
  /** `message_send(conversation_id, client_id, type, text, payload, reply_to_message_id)`; idempotent on `clientId`. */
  send(input: MessageSendInputLike): Promise<MessageDto>
  /** `message_edit(message_id, text)`: the edited message. */
  edit(input: MessageEditInput): Promise<MessageDto>
  /** `message_delete(message_id)`: the tombstone (`deletedAt` set, `text` null). */
  delete(messageId: MessageId): Promise<MessageDto>
  readonly reactions: MessageReactionsNamespace
}

export interface ConversationsNamespace {
  /** `conversations_list(cursor, limit)` ordered by `last_message_at desc`. */
  list(input?: ConversationsListInput): Promise<ConversationsPageDto>
  /** `conversation_get(conversation_id)`: summary + members. */
  get(conversationId: ConversationId): Promise<ConversationDetailDto>
  /** `conversation_direct_get_or_create(other_human_id)`. */
  directWith(humanId: HumanId): Promise<ConversationSummaryDto>
  /** `conversation_group_create(human_ids)`: two or more others (spec §9 New chat). */
  createGroup(humanIds: readonly HumanId[]): Promise<ConversationSummaryDto>
  /** SCREEN 09: one Human → `directWith`, two or more → `createGroup`. */
  create(input: ConversationCreateInput): Promise<ConversationSummaryDto>
  /** `conversation_set_prefs(conversation_id, mute_state, notification_level)`. */
  setPrefs(input: ConversationPrefsInput): Promise<ConversationPrefsDto>
  /** `conversation_read_receipts(conversation_id)` for "Seen by". */
  readReceipts(conversationId: ConversationId): Promise<ReadReceiptDto[]>
  /** `conversation_mark_read(conversation_id, message_id)`: the caller's read state afterwards. */
  markRead(input: ConversationMarkReadInput): Promise<ConversationReadStateDto>
  readonly messages: MessagesNamespace
}

const GroupHumanIdsSchema = ConversationCreateInputSchema.shape.humanIds.min(2)

export function createConversationsNamespace(transport: Transport): ConversationsNamespace {
  const reactions: MessageReactionsNamespace = {
    toggle(input) {
      const parsed = parseInput(ReactionToggleInputSchema, input)
      return transport.call(CALLS.messagesReactionsToggle, {
        message_id: parsed.messageId,
        reaction: parsed.reaction,
      })
    },
  }

  const messages: MessagesNamespace = {
    list(input) {
      const parsed = parseInput(MessagesListInputSchema, input)
      return transport.call(CALLS.messagesList, {
        conversation_id: parsed.conversationId,
        before_id: parsed.beforeId ?? null,
        limit: parsed.limit ?? MESSAGES_PAGE_SIZE,
      })
    },
    since(input) {
      const parsed = parseInput(MessagesSinceInputSchema, input)
      return transport.call(CALLS.messagesSince, {
        conversation_id: parsed.conversationId,
        after_id: parsed.afterId,
      })
    },
    send(input) {
      const parsed = parseInput(MessageSendInputSchema, input)
      return transport.call(CALLS.messagesSend, {
        conversation_id: parsed.conversationId,
        client_id: parsed.clientId,
        type: parsed.type,
        text: parsed.text,
        payload: parsed.payload,
        reply_to_message_id: parsed.replyToMessageId,
      })
    },
    edit(input) {
      const parsed = parseInput(MessageEditInputSchema, input)
      return transport.call(CALLS.messagesEdit, { message_id: parsed.messageId, text: parsed.text })
    },
    delete(messageId) {
      const id = parseInput(MessageIdSchema, messageId, 'messageId')
      return transport.call(CALLS.messagesDelete, { message_id: id })
    },
    reactions,
  }

  const directWith = (humanId: HumanId): Promise<ConversationSummaryDto> =>
    transport.call(CALLS.conversationsDirectWith, {
      other_human_id: parseInput(HumanIdSchema, humanId, 'humanId'),
    })

  const createGroup = (humanIds: readonly HumanId[]): Promise<ConversationSummaryDto> =>
    transport.call(CALLS.conversationsCreateGroup, {
      human_ids: parseInput(GroupHumanIdsSchema, humanIds, 'humanIds'),
    })

  return {
    list(input = {}) {
      const parsed = parseInput(ConversationsListInputSchema, input)
      return transport.call(CALLS.conversationsList, {
        cursor: parsed.cursor ?? null,
        limit: parsed.limit ?? null,
      })
    },
    get(conversationId) {
      const id = parseInput(ConversationIdSchema, conversationId, 'conversationId')
      return transport.call(CALLS.conversationsGet, { conversation_id: id })
    },
    directWith,
    createGroup,
    create(input) {
      const parsed = parseInput(ConversationCreateInputSchema, input)
      const [first] = parsed.humanIds
      return parsed.humanIds.length === 1 && first !== undefined
        ? directWith(first)
        : createGroup(parsed.humanIds)
    },
    setPrefs(input) {
      const parsed = parseInput(ConversationPrefsInputSchema, input)
      return transport.call(CALLS.conversationsSetPrefs, {
        conversation_id: parsed.conversationId,
        mute_state: parsed.muteState ?? null,
        notification_level: parsed.notificationLevel ?? null,
      })
    },
    readReceipts(conversationId) {
      const id = parseInput(ConversationIdSchema, conversationId, 'conversationId')
      return transport.call(CALLS.conversationsReadReceipts, { conversation_id: id })
    },
    markRead(input) {
      const parsed = parseInput(ConversationMarkReadInputSchema, input)
      return transport.call(CALLS.conversationsMarkRead, {
        conversation_id: parsed.conversationId,
        message_id: parsed.lastReadMessageId,
      })
    },
    messages,
  }
}
