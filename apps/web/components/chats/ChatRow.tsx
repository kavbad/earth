'use client'

/**
 * One row of SCREEN 08: faces, conversation name, the last meaningful message or a contextual
 * state ("Maya + 2 live") when the group has a room open, unread state, a compact time.
 */
import type { ConversationSummaryDto, HumanId } from '@earth/domain'
import { copy, relativeTime } from '@earth/ui'
import Link from 'next/link'
import { memo } from 'react'

import { Avatar } from '../ui/Avatar'
import { FaceStack } from '../ui/FaceStack'
import { cx } from '../ui/cx'
import { chatCopy } from './copy'
import { useActiveRoomNames } from './hooks/useActiveRoomNames'
import { messagePreviewText } from './payloads'
import { conversationRoute } from './routes'
import { isUnread } from './state/read'

export interface ChatRowProps {
  readonly conversation: ConversationSummaryDto
  readonly viewerId: HumanId | null
  readonly now?: Date
}

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

function ChatRowView({ conversation, viewerId, now }: ChatRowProps) {
  const activeRoom = conversation.activeRoom
  const live = useActiveRoomNames(activeRoom?.roomId ?? null, activeRoom?.participantCount ?? 0)
  const unread = isUnread(conversation)
  const liveLine = activeRoom === null ? '' : copy.chatRowLive(live.names, live.total)
  const subtitle = liveLine.length > 0 ? liveLine : previewLine(conversation, viewerId)
  const time =
    conversation.lastMessageAt === null ? '' : relativeTime(conversation.lastMessageAt, now)
  const people = conversation.avatarUrls.map((avatarUrl, index) => ({
    displayName: index === 0 ? conversation.title : '',
    avatarUrl,
  }))
  const rowLabel = copy.chatRowLine(conversation.title, subtitle)

  return (
    <Link
      href={conversationRoute(conversation.id)}
      role="listitem"
      aria-label={unread ? `${rowLabel} · ${chatCopy.unread(conversation.unreadCount)}` : rowLabel}
      className="flex min-h-touch-target w-full items-center gap-3 px-screen-margin py-3 transition-colors duration-fast ease-standard hover:bg-subtle-fill"
    >
      <span className="shrink-0">
        {people.length > 1 ? (
          <FaceStack people={people} max={2} size="medium" label={conversation.title} />
        ) : (
          <Avatar
            name={conversation.title}
            src={people[0]?.avatarUrl ?? null}
            size="medium"
            decorative
            live={activeRoom !== null}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span
            className={cx(
              'min-w-0 flex-1 truncate text-body',
              unread ? 'font-medium text-text-primary' : 'text-text-primary',
            )}
          >
            {conversation.title}
          </span>
          {time.length > 0 ? (
            <span className="shrink-0 text-meta font-regular text-text-secondary">{time}</span>
          ) : null}
        </span>
        <span className="flex items-center gap-2">
          {activeRoom !== null ? (
            <span aria-hidden="true" className="size-2 shrink-0 rounded-avatar bg-live" />
          ) : null}
          <span
            className={cx(
              'min-w-0 flex-1 truncate text-secondary',
              activeRoom !== null
                ? 'text-text-primary'
                : unread
                  ? 'text-text-primary'
                  : 'text-text-secondary',
            )}
          >
            {subtitle}
          </span>
          {unread ? (
            <span aria-hidden="true" className="size-2 shrink-0 rounded-avatar bg-earth-accent" />
          ) : null}
        </span>
      </span>
    </Link>
  )
}

export const ChatRow = memo(ChatRowView)
