import { z } from 'zod'

import { MESSAGE_TEXT_MAX } from '../constants'
import { ConversationTypeSchema, MessageTypeSchema } from '../enums'
import { ConversationIdSchema, GroupIdSchema, HumanIdSchema, MessageIdSchema } from '../ids'
import { DisplayNameSchema, HandleSchema } from './claim'
import {
  IsoDateTimeSchema,
  JsonObjectSchema,
  NonNegativeIntSchema,
  NullableCursorSchema,
  NullableUrlSchema,
  UrlSchema,
} from './common'
import { ActiveRoomRefDtoSchema } from './groups'

export const MessageTextSchema = z.string().max(MESSAGE_TEXT_MAX)

/** Last meaningful message on a chats row ("Dad: photo"). */
export const LastMessagePreviewDtoSchema = z.object({
  id: MessageIdSchema,
  senderHumanId: HumanIdSchema,
  senderDisplayName: DisplayNameSchema,
  type: MessageTypeSchema,
  text: MessageTextSchema.nullable(),
  createdAt: IsoDateTimeSchema,
})
export type LastMessagePreviewDto = z.infer<typeof LastMessagePreviewDtoSchema>

/** One row of SCREEN 08 (Chats list). */
export const ConversationSummaryDtoSchema = z.object({
  id: ConversationIdSchema,
  type: ConversationTypeSchema,
  groupId: GroupIdSchema.nullable(),
  /** Group name or generated member names (SCREEN 10). */
  title: z.string().min(1),
  avatarUrls: z.array(UrlSchema),
  lastMessage: LastMessagePreviewDtoSchema.nullable(),
  unreadCount: NonNegativeIntSchema,
  activeRoom: ActiveRoomRefDtoSchema.nullable(),
  lastMessageAt: IsoDateTimeSchema.nullable(),
})
export type ConversationSummaryDto = z.infer<typeof ConversationSummaryDtoSchema>

export const ConversationsListDtoSchema = z.object({
  conversations: z.array(ConversationSummaryDtoSchema),
})
export type ConversationsListDto = z.infer<typeof ConversationsListDtoSchema>

/** `conversation_members` (spec §26) joined with public identity; `lastReadMessageId` feeds "Seen by". */
export const ConversationMemberDtoSchema = z.object({
  humanId: HumanIdSchema,
  displayName: DisplayNameSchema,
  handle: HandleSchema,
  avatarUrl: NullableUrlSchema,
  joinedAt: IsoDateTimeSchema,
  lastReadMessageId: MessageIdSchema.nullable(),
})
export type ConversationMemberDto = z.infer<typeof ConversationMemberDtoSchema>

/** `conversation_get` (DB_API §2): the summary plus its members (SCREEN 10/11 headers, "Seen by"). */
export const ConversationDetailDtoSchema = ConversationSummaryDtoSchema.extend({
  members: z.array(ConversationMemberDtoSchema),
})
export type ConversationDetailDto = z.infer<typeof ConversationDetailDtoSchema>

export const MessageReactionSummaryDtoSchema = z.object({
  reaction: z.string().min(1),
  count: NonNegativeIntSchema,
  reactedByMe: z.boolean(),
})
export type MessageReactionSummaryDto = z.infer<typeof MessageReactionSummaryDtoSchema>

/** `messages` (spec §27) with reaction summaries. Deleted messages keep a tombstone. */
export const MessageDtoSchema = z.object({
  id: MessageIdSchema,
  conversationId: ConversationIdSchema,
  senderHumanId: HumanIdSchema,
  type: MessageTypeSchema,
  text: MessageTextSchema.nullable(),
  payload: JsonObjectSchema,
  replyToMessageId: MessageIdSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  editedAt: IsoDateTimeSchema.nullable(),
  deletedAt: IsoDateTimeSchema.nullable(),
  /** Client-generated id used for idempotent sends (spec §53); `null` for system messages. */
  clientId: z.uuid().nullable(),
  reactions: z.array(MessageReactionSummaryDtoSchema),
})
export type MessageDto = z.infer<typeof MessageDtoSchema>

/** Keyset page, newest first; `nextCursor` walks backwards in time. */
export const MessagesPageDtoSchema = z.object({
  messages: z.array(MessageDtoSchema),
  nextCursor: NullableCursorSchema,
})
export type MessagesPageDto = z.infer<typeof MessagesPageDtoSchema>

export const MessageSendInputSchema = z
  .object({
    conversationId: ConversationIdSchema,
    /** Client-generated UUID; retries with the same id are idempotent (spec §53). */
    clientId: z.uuid(),
    type: MessageTypeSchema.exclude(['system']),
    text: MessageTextSchema.nullable(),
    payload: JsonObjectSchema.default({}),
    replyToMessageId: MessageIdSchema.nullable(),
  })
  .refine(
    (input) => input.type !== 'text' || (input.text !== null && input.text.trim().length > 0),
    {
      message: 'text messages need text',
      path: ['text'],
    },
  )
export type MessageSendInput = z.infer<typeof MessageSendInputSchema>

export const MessageEditInputSchema = z.object({
  messageId: MessageIdSchema,
  text: MessageTextSchema.trim().min(1),
})
export type MessageEditInput = z.infer<typeof MessageEditInputSchema>

export const ReactionToggleInputSchema = z.object({
  messageId: MessageIdSchema,
  reaction: z.string().min(1).max(16),
})
export type ReactionToggleInput = z.infer<typeof ReactionToggleInputSchema>

/** SCREEN 09: one Human → DM, two or more → group conversation. */
export const ConversationCreateInputSchema = z.object({
  humanIds: z.array(HumanIdSchema).min(1).max(50),
})
export type ConversationCreateInput = z.infer<typeof ConversationCreateInputSchema>

export const ConversationMarkReadInputSchema = z.object({
  conversationId: ConversationIdSchema,
  lastReadMessageId: MessageIdSchema,
})
export type ConversationMarkReadInput = z.infer<typeof ConversationMarkReadInputSchema>
