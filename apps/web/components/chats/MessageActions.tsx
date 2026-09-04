'use client'

/**
 * The action sheet a message opens on long-press, hover "…" or keyboard (spec §55 "details on
 * message action"; §108 retry): quick reactions, Reply, Copy text, Seen by, Delete, and for a
 * failed message "Tap to retry" / Discard.
 */
import type { ConversationMemberDto, HumanId, MessageId } from '@earth/domain'
import { copy } from '@earth/ui'

import { Button } from '../ui/Button'
import { Sheet } from '../ui/Sheet'
import { cx } from '../ui/cx'
import { chatCopy } from './copy'
import { isPollVoteReaction } from './payloads'
import type { ChatMessage } from './state/messages'
import type { SeenBy } from './state/read'

export const QUICK_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🙏'] as const

export interface MessageActionsProps {
  readonly message: ChatMessage | null
  readonly isMine: boolean
  readonly seenBy: SeenBy | null
  readonly members: readonly ConversationMemberDto[]
  readonly onClose: () => void
  readonly onReact: (messageId: MessageId, reaction: string) => void
  readonly onReply: (message: ChatMessage) => void
  readonly onDelete: (messageId: MessageId) => void
  readonly onRetry: (clientId: string) => void
  readonly onDiscard: (clientId: string) => void
}

export function MessageActions({
  message,
  isMine,
  seenBy,
  members,
  onClose,
  onReact,
  onReply,
  onDelete,
  onRetry,
  onDiscard,
}: MessageActionsProps) {
  const open = message !== null
  const sent = message?.status === 'sent'
  const failed = message?.status === 'failed'
  const readers: readonly HumanId[] =
    message !== null && seenBy?.messageId === message.id ? seenBy.humanIds : []
  const readerNames = readers
    .map((id) => members.find((member) => member.humanId === id)?.displayName ?? null)
    .filter((name): name is string => name !== null)
  const canCopy =
    message !== null &&
    message.deletedAt === null &&
    (message.text ?? '').trim().length > 0 &&
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.writeText === 'function'

  return (
    <Sheet open={open} onClose={onClose} title={chatCopy.messageActions}>
      {message === null ? null : (
        <div className="flex flex-col gap-2">
          {sent && message.deletedAt === null ? (
            <div
              role="group"
              aria-label={chatCopy.react}
              className="flex justify-between gap-1 pb-2"
            >
              {QUICK_REACTIONS.map((reaction) => {
                const mine = message.reactions.some(
                  (summary) =>
                    summary.reaction === reaction &&
                    summary.reactedByMe &&
                    !isPollVoteReaction(reaction),
                )
                return (
                  <button
                    key={reaction}
                    type="button"
                    aria-label={reaction}
                    aria-pressed={mine}
                    onClick={() => {
                      onReact(message.id, reaction)
                      onClose()
                    }}
                    className={cx(
                      'flex size-touch-target items-center justify-center rounded-avatar text-title transition-colors duration-fast ease-standard',
                      mine ? 'bg-subtle-fill' : 'hover:bg-subtle-fill',
                    )}
                  >
                    {reaction}
                  </button>
                )
              })}
            </div>
          ) : null}
          {failed && message.clientId !== null ? (
            <>
              <Button
                variant="primary"
                fullWidth
                onClick={() => {
                  onRetry(message.clientId ?? '')
                  onClose()
                }}
              >
                {copy.tapToRetry}
              </Button>
              <Button
                variant="destructive"
                fullWidth
                onClick={() => {
                  onDiscard(message.clientId ?? '')
                  onClose()
                }}
              >
                {chatCopy.discard}
              </Button>
            </>
          ) : null}
          {sent && message.deletedAt === null ? (
            <Button
              variant="quiet"
              fullWidth
              onClick={() => {
                onReply(message)
                onClose()
              }}
            >
              {copy.reply}
            </Button>
          ) : null}
          {canCopy ? (
            <Button
              variant="quiet"
              fullWidth
              onClick={() => {
                void navigator.clipboard.writeText(message.text ?? '')
                onClose()
              }}
            >
              {chatCopy.copyText}
            </Button>
          ) : null}
          {isMine && readerNames.length > 0 ? (
            <p className="px-2 py-2 text-secondary text-text-secondary">
              {chatCopy.seenBy(readerNames.join(', '))}
            </p>
          ) : null}
          {isMine && sent && message.deletedAt === null ? (
            <Button
              variant="destructive"
              fullWidth
              onClick={() => {
                onDelete(message.id)
                onClose()
              }}
            >
              {chatCopy.deleteMessage}
            </Button>
          ) : null}
        </div>
      )}
    </Sheet>
  )
}
