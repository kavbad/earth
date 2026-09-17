/**
 * The action sheet a message opens on long-press (spec §55 "details on message action"; §108
 * retry): quick reactions, Reply, Copy text, Seen by, Delete, and for a failed message "Tap to
 * retry" / Discard.
 */
import type { ConversationMemberDto, HumanId, MessageId } from '@earth/domain'
import { colors, copy, radius, space, touchTarget } from '@earth/ui'
import * as Clipboard from 'expo-clipboard'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { chatCopy } from '@/features/chats/copy'
import { lightTap } from '@/lib/haptics'
import { isPollVoteReaction } from '@/features/chats/payloads'
import type { ChatMessage } from '@/features/chats/state/messages'
import type { SeenBy } from '@/features/chats/state/read'

import { Button, Sheet, text } from '@/components/ui'

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
  readonly onCopied: () => void
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
  onCopied,
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
    message !== null && message.deletedAt === null && (message.text ?? '').trim().length > 0

  return (
    <Sheet open={open} onClose={onClose} title={chatCopy.messageActions}>
      {message === null ? null : (
        <View style={styles.stack}>
          {sent && message.deletedAt === null ? (
            <View
              style={styles.reactions}
              accessibilityRole="radiogroup"
              accessibilityLabel={chatCopy.react}
            >
              {QUICK_REACTIONS.map((reaction) => {
                const mine = message.reactions.some(
                  (summary) =>
                    summary.reaction === reaction &&
                    summary.reactedByMe &&
                    !isPollVoteReaction(reaction),
                )
                return (
                  <Pressable
                    key={reaction}
                    onPress={() => {
                      lightTap()
                      onReact(message.id, reaction)
                      onClose()
                    }}
                    accessibilityRole="radio"
                    accessibilityLabel={reaction}
                    accessibilityState={{ checked: mine }}
                    style={({ pressed }) => [
                      styles.reaction,
                      (mine || pressed) && styles.reactionActive,
                    ]}
                  >
                    <Text style={text.title}>{reaction}</Text>
                  </Pressable>
                )
              })}
            </View>
          ) : null}
          {failed && message.clientId !== null ? (
            <>
              <Button
                label={copy.tapToRetry}
                fullWidth
                onPress={() => {
                  onRetry(message.clientId ?? '')
                  onClose()
                }}
              />
              <Button
                label={chatCopy.discard}
                variant="destructive"
                fullWidth
                onPress={() => {
                  onDiscard(message.clientId ?? '')
                  onClose()
                }}
              />
            </>
          ) : null}
          {sent && message.deletedAt === null ? (
            <Button
              label={copy.reply}
              variant="quiet"
              fullWidth
              onPress={() => {
                onReply(message)
                onClose()
              }}
            />
          ) : null}
          {canCopy ? (
            <Button
              label={chatCopy.copyText}
              variant="quiet"
              fullWidth
              onPress={() => {
                void Clipboard.setStringAsync(message.text ?? '')
                  .then(() => onCopied())
                  .catch(() => undefined)
                onClose()
              }}
            />
          ) : null}
          {isMine && readerNames.length > 0 ? (
            <Text style={[text.secondary, text.muted, styles.seenBy]}>
              {chatCopy.seenBy(readerNames.join(', '))}
            </Text>
          ) : null}
          {isMine && sent && message.deletedAt === null ? (
            <Button
              label={chatCopy.deleteMessage}
              variant="destructive"
              fullWidth
              onPress={() => {
                onDelete(message.id)
                onClose()
              }}
            />
          ) : null}
        </View>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  stack: { gap: space[2] },
  reactions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: space[1],
    paddingBottom: space[2],
  },
  reaction: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radius.avatar,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionActive: { backgroundColor: colors.subtleFill },
  seenBy: { paddingHorizontal: space[2], paddingVertical: space[2] },
})
