'use client'

/**
 * SCREEN 10/11 header: back, faces + name (tap → info), a quiet presence line (typing / active),
 * and — only when the group has a room open — the contextual `3 live · Join` line to the room.
 */
import type { ConversationDetailDto } from '@earth/domain'
import { copy, namesWithPlus } from '@earth/ui'
import Link from 'next/link'

import { webCopy } from '../../lib/copy'
import { TAB_ROUTES } from '../../lib/routes'
import { CONTENT_MAX_WIDTH_CLASS } from '../shell/PageContainer'
import { FaceStack } from '../ui/FaceStack'
import { Icon } from '../ui/Icon'
import { Skeleton } from '../ui/Skeleton'
import { chatCopy } from './copy'
import type { ConversationPresence } from './hooks/useConversation'
import { conversationInfoRoute, roomRoute } from './routes'

export interface ConversationHeaderProps {
  readonly conversationId: string
  readonly conversation: ConversationDetailDto | undefined
  readonly presence: ConversationPresence
  readonly liveCount: number
}

/** `Maya typing…` · `Maya + 2 active` · empty when nobody is here. */
export function presenceLine(presence: ConversationPresence): string {
  if (presence.typingNames.length > 0) return chatCopy.typing(namesWithPlus(presence.typingNames))
  if (presence.activeNames.length > 0) return chatCopy.active(namesWithPlus(presence.activeNames))
  return ''
}

export function ConversationHeader({
  conversationId,
  conversation,
  presence,
  liveCount,
}: ConversationHeaderProps) {
  const subtitle = presenceLine(presence)
  const people = (conversation?.members ?? []).map((member) => ({
    displayName: member.displayName,
    avatarUrl: member.avatarUrl,
  }))
  const activeRoom = conversation?.activeRoom ?? null
  return (
    <header className="sticky top-0 z-sticky bg-background pt-[env(safe-area-inset-top)] hairline-b">
      <div className={`mx-auto flex flex-col px-screen-margin ${CONTENT_MAX_WIDTH_CLASS}`}>
        <div className="flex min-h-touch-target items-center gap-2 py-1">
          <Link
            href={TAB_ROUTES.chats}
            aria-label={webCopy.back}
            className="-ml-2 flex size-touch-target shrink-0 items-center justify-center rounded-avatar text-text-primary hover:bg-subtle-fill"
          >
            <Icon name="back" />
          </Link>
          {conversation === undefined ? (
            <div className="flex flex-1 items-center gap-3">
              <Skeleton className="size-8 rounded-avatar" />
              <Skeleton className="h-4 w-32" />
            </div>
          ) : (
            <Link
              href={conversationInfoRoute(conversationId)}
              aria-label={`${conversation.title} · ${chatCopy.openInfo}`}
              className="flex min-w-0 flex-1 items-center gap-3 rounded-medium py-1 pr-2 transition-colors duration-fast ease-standard hover:bg-subtle-fill"
            >
              <FaceStack
                people={
                  people.length > 0
                    ? people
                    : [
                        {
                          displayName: conversation.title,
                          avatarUrl: conversation.avatarUrls[0] ?? null,
                        },
                      ]
                }
                max={conversation.type === 'direct' ? 1 : 3}
                total={conversation.members.length}
                size="small"
                label={conversation.title}
              />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-section">{conversation.title}</span>
                {subtitle.length > 0 ? (
                  <span role="status" className="truncate text-secondary text-text-secondary">
                    {subtitle}
                  </span>
                ) : null}
              </span>
            </Link>
          )}
        </div>
        {activeRoom !== null && liveCount > 0 ? (
          <Link
            href={roomRoute(activeRoom.roomId)}
            className="flex min-h-touch-target items-center gap-2 pb-2 text-secondary text-text-primary"
          >
            <span aria-hidden="true" className="size-2 rounded-avatar bg-live" />
            <span>{copy.liveJoinLine(liveCount)}</span>
          </Link>
        ) : null}
      </div>
    </header>
  )
}
