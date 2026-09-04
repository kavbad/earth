'use client'

/**
 * One row of the thread (spec §94): a day separator when the day changes, the sender's face and
 * name at the start of a group, the bubble (no gradients), the reply quote, reactions, and the
 * quiet delivery / read state under the last row of a group. Long-press or the hover "…" opens
 * the actions sheet.
 */
import type { ConversationMemberDto, HumanId, MessageId } from '@earth/domain'
import { copy } from '@earth/ui'
import { type PointerEvent as ReactPointerEvent, memo, useRef } from 'react'

import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { cx } from '../ui/cx'
import { MessageBody } from './MessageBody'
import { chatCopy } from './copy'
import { isPollVoteReaction, messagePreviewText } from './payloads'
import { type ChatMessage, type MessageRow, timeLabel } from './state/messages'

export const LONG_PRESS_MS = 450

export interface MessageBubbleProps {
  readonly row: MessageRow
  readonly senderName: string
  readonly sender: ConversationMemberDto | undefined
  readonly replyTo: ChatMessage | null
  readonly replyToName: string
  readonly seenByLine: string | null
  readonly onOpenActions: (message: ChatMessage) => void
  readonly onToggleReaction: (messageId: MessageId, reaction: string) => void
  readonly onRetry: (clientId: string) => void
}

function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = null
  }
  return {
    onPointerDown: (event: ReactPointerEvent) => {
      if (event.pointerType === 'mouse') return
      clear()
      timer.current = setTimeout(() => {
        timer.current = null
        onLongPress()
      }, LONG_PRESS_MS)
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onPointerMove: clear,
  }
}

function MessageBubbleView({
  row,
  senderName,
  sender,
  replyTo,
  replyToName,
  seenByLine,
  onOpenActions,
  onToggleReaction,
  onRetry,
}: MessageBubbleProps) {
  const { message, isMine, position, dayLabel, showTime } = row
  const longPress = useLongPress(() => onOpenActions(message))
  const startsGroup = position === 'first' || position === 'single'
  const endsGroup = position === 'last' || position === 'single'
  const reactions = message.reactions.filter(
    (summary) => summary.count > 0 && !isPollVoteReaction(summary.reaction),
  )
  const wide = message.type === 'image' || message.type === 'video' || message.type === 'poll'

  if (message.type === 'system') {
    return (
      <div className="px-screen-margin">
        {dayLabel !== null ? <DaySeparator label={dayLabel} /> : null}
        <p className="py-2 text-center text-meta text-text-secondary">{message.text ?? ''}</p>
      </div>
    )
  }

  return (
    <div
      className={cx('px-screen-margin', startsGroup ? 'pt-3' : 'pt-1', endsGroup ? 'pb-1' : 'pb-0')}
    >
      {dayLabel !== null ? <DaySeparator label={dayLabel} /> : null}
      <div className={cx('group flex items-end gap-2', isMine ? 'flex-row-reverse' : 'flex-row')}>
        {!isMine ? (
          <span className="w-8 shrink-0">
            {endsGroup ? (
              <Avatar name={senderName} src={sender?.avatarUrl ?? null} size="small" decorative />
            ) : null}
          </span>
        ) : null}
        <div
          className={cx('flex min-w-0 max-w-[78%] flex-col', isMine ? 'items-end' : 'items-start')}
        >
          {!isMine && startsGroup ? (
            <span className="mb-1 pl-3 text-meta text-text-secondary">{senderName}</span>
          ) : null}
          <div
            {...longPress}
            className={cx(
              'relative rounded-medium transition-opacity duration-fast ease-standard',
              wide ? 'p-1' : 'px-3 py-2',
              isMine ? 'bg-text-primary text-background' : 'bg-subtle-fill text-text-primary',
              message.status === 'pending' && 'opacity-70',
              message.status === 'failed' && 'opacity-60',
              !startsGroup && (isMine ? 'rounded-tr-small' : 'rounded-tl-small'),
              !endsGroup && (isMine ? 'rounded-br-small' : 'rounded-bl-small'),
            )}
          >
            {replyTo !== null || message.replyToMessageId !== null ? (
              <blockquote
                className={cx(
                  'mb-1 border-l-2 pl-2 text-secondary',
                  isMine
                    ? 'border-background/50 text-background/80'
                    : 'border-separator text-text-secondary',
                )}
              >
                <span className="block text-meta">{replyToName}</span>
                <span className="line-clamp-2">
                  {replyTo === null ? '…' : messagePreviewText(replyTo.type, replyTo.text)}
                </span>
              </blockquote>
            ) : null}
            <MessageBody
              message={message}
              isMine={isMine}
              senderName={senderName}
              onToggleReaction={onToggleReaction}
            />
            {message.editedAt !== null && message.deletedAt === null ? (
              <span
                className={cx(
                  'mt-1 block text-meta',
                  isMine ? 'text-background/70' : 'text-text-secondary',
                )}
              >
                {chatCopy.edited}
              </span>
            ) : null}
            <button
              type="button"
              aria-label={chatCopy.messageActions}
              onClick={() => onOpenActions(message)}
              className={cx(
                'absolute top-0 flex size-8 items-center justify-center rounded-avatar bg-background text-text-secondary opacity-0 shadow-none transition-opacity duration-fast ease-standard hairline group-hover:opacity-100 focus-visible:opacity-100',
                isMine ? '-left-10' : '-right-10',
              )}
            >
              <Icon name="more" size="small" />
            </button>
          </div>
          {reactions.length > 0 ? (
            <div
              className={cx(
                '-mt-1 flex flex-wrap gap-1 px-1',
                isMine ? 'justify-end' : 'justify-start',
              )}
            >
              {reactions.map((summary) => (
                <button
                  key={summary.reaction}
                  type="button"
                  aria-pressed={summary.reactedByMe}
                  aria-label={`${summary.reaction} ${summary.count}`}
                  onClick={() => onToggleReaction(message.id, summary.reaction)}
                  className={cx(
                    'inline-flex min-h-6 items-center gap-1 rounded-avatar bg-background px-2 text-meta text-text-primary hairline',
                    summary.reactedByMe && 'border-text-primary',
                  )}
                >
                  <span aria-hidden="true">{summary.reaction}</span>
                  {summary.count > 1 ? <span>{summary.count}</span> : null}
                </button>
              ))}
            </div>
          ) : null}
          {message.status === 'failed' ? (
            <button
              type="button"
              onClick={() => {
                if (message.clientId !== null) onRetry(message.clientId)
              }}
              className="mt-1 flex items-center gap-1 text-meta text-danger"
            >
              <span aria-hidden="true" className="size-2 rounded-avatar bg-danger" />
              {chatCopy.failedToSend} · {copy.tapToRetry}
            </button>
          ) : message.status === 'pending' ? (
            <span className="mt-1 text-meta text-text-secondary">{chatCopy.sending}</span>
          ) : showTime ? (
            <span className="mt-1 flex items-center gap-2 text-meta text-text-secondary">
              <span>{timeLabel(message.createdAt)}</span>
              {seenByLine !== null ? <span>· {seenByLine}</span> : null}
            </span>
          ) : seenByLine !== null ? (
            <span className="mt-1 text-meta text-text-secondary">{seenByLine}</span>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function DaySeparator({ label }: { readonly label: string }) {
  return (
    <div className="flex items-center justify-center py-3">
      <span className="text-meta text-text-secondary">{label}</span>
    </div>
  )
}

export const MessageBubble = memo(MessageBubbleView)

/** Convenience for the thread: the sender's name from the members map. */
export function displayNameFor(
  humanId: HumanId,
  members: ReadonlyMap<HumanId, ConversationMemberDto>,
  viewerId: HumanId | null,
): string {
  if (humanId === viewerId) return chatCopy.you
  return members.get(humanId)?.displayName ?? copy.human
}
