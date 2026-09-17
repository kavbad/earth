/**
 * SCREEN 08 / SCREEN 10 row and header lines, pure: the subtitle of a chats row, the client-side
 * search filter, and the presence line (`Maya typing…` · `Maya + 2 active`).
 */
import type { ConversationSummaryDto, HumanId } from '@earth/domain'
import { copy, namesWithPlus } from '@earth/ui'

import { chatCopy } from '../copy'
import { messagePreviewText } from '../payloads'

/** The subtitle of a row without a live room: `Dad: photo` · `You: On my way` · `Anyone around?`. */
export function previewLine(
  conversation: ConversationSummaryDto,
  viewerId: HumanId | null,
): string {
  const last = conversation.lastMessage
  if (last === null) return ''
  const preview = messagePreviewText(last.type, last.text)
  if (last.type === 'system') return preview
  if (viewerId !== null && last.senderHumanId === viewerId) {
    return copy.messagePreview(chatCopy.you, preview)
  }
  return conversation.type === 'group'
    ? copy.messagePreview(last.senderDisplayName, preview)
    : preview
}

/** Client-side filter of loaded rows by name and last message (SCREEN 08 "Search at top"). */
export function filterConversations(
  conversations: readonly ConversationSummaryDto[],
  query: string,
): ConversationSummaryDto[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...conversations]
  return conversations.filter(
    (conversation) =>
      conversation.title.toLowerCase().includes(needle) ||
      previewLine(conversation, null).toLowerCase().includes(needle),
  )
}

/** Rows from several pages, deduplicated by id in page order. */
export function dedupeConversations(
  pages: ReadonlyArray<{ readonly conversations: readonly ConversationSummaryDto[] }>,
): ConversationSummaryDto[] {
  const seen = new Set<string>()
  const rows: ConversationSummaryDto[] = []
  for (const page of pages) {
    for (const conversation of page.conversations) {
      if (seen.has(conversation.id)) continue
      seen.add(conversation.id)
      rows.push(conversation)
    }
  }
  return rows
}

export interface ConversationPresence {
  readonly typingNames: readonly string[]
  readonly activeNames: readonly string[]
}

export const EMPTY_PRESENCE: ConversationPresence = { typingNames: [], activeNames: [] }

/** `Maya typing…` · `Maya + 2 active` · empty when nobody is here. */
export function presenceLine(presence: ConversationPresence): string {
  if (presence.typingNames.length > 0) return chatCopy.typing(namesWithPlus(presence.typingNames))
  if (presence.activeNames.length > 0) return chatCopy.active(namesWithPlus(presence.activeNames))
  return ''
}

/** The accessible label of a chats row: `College — Maya + 2 live · 3 unread`. */
export function chatRowLabel(
  conversation: Pick<ConversationSummaryDto, 'title' | 'unreadCount'>,
  subtitle: string,
): string {
  const line = copy.chatRowLine(conversation.title, subtitle)
  return conversation.unreadCount > 0
    ? `${line} · ${chatCopy.unread(conversation.unreadCount)}`
    : line
}
