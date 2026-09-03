/**
 * Analytics helpers for the messaging events of spec §97: the conversation context every
 * messaging event carries (`conversationId`, `conversationType`, `groupId` when there is one).
 */
import type { AnalyticsEventMap } from '@earth/analytics'
import type { ConversationDetailDto, ConversationId } from '@earth/domain'

export type MessageEventContext = Pick<
  AnalyticsEventMap['message_sent'],
  'conversationId' | 'conversationType' | 'groupId'
>

export function messageEventContext(
  conversation: Pick<ConversationDetailDto, 'type' | 'groupId'> | undefined,
  conversationId: ConversationId,
): MessageEventContext {
  const type = conversation?.type ?? 'direct'
  const groupId = conversation?.groupId ?? null
  return groupId === null
    ? { conversationId, conversationType: type }
    : { conversationId, conversationType: type, groupId }
}
