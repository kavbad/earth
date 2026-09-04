/**
 * One row of the thread (spec §94): a day separator when the day changes, the sender's face and
 * name at the start of a group, the bubble (no gradients), the reply quote, reactions, and the
 * quiet delivery / read state under the last row of a group. Long-press opens the actions sheet
 * (with a light haptic); a failed message retries on tap (spec §108).
 */
import type { MessageId } from '@earth/domain'
import {
  avatarSize,
  borderWidth,
  colors,
  copy,
  radius,
  space,
  spacing,
  touchTarget,
} from '@earth/ui'
import { memo } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { chatCopy } from '@/features/chats/copy'
import { lightTap } from '@/lib/haptics'
import { isPollVoteReaction, messagePreviewText } from '@/features/chats/payloads'
import { type ChatMessage, type MessageRow, timeLabel } from '@/features/chats/state/messages'

import { MessageBody } from './MessageBody'
import { Avatar, text } from '@/components/ui'

export const LONG_PRESS_MS = 450
/** Reaction chips and the status line draw 24pt tall; their hit area reaches 44pt. */
const SMALL_ROW_HEIGHT = space[6]
const SMALL_ROW_HIT_SLOP = (touchTarget - SMALL_ROW_HEIGHT) / 2

export interface MessageBubbleProps {
  readonly row: MessageRow
  readonly senderName: string
  readonly senderAvatarUrl: string | null
  readonly replyTo: ChatMessage | null
  readonly replyToName: string
  readonly seenByLine: string | null
  readonly onOpenActions: (message: ChatMessage) => void
  readonly onToggleReaction: (messageId: MessageId, reaction: string) => void
  readonly onRetry: (clientId: string) => void
}

function DaySeparator({ label }: { readonly label: string }) {
  return (
    <View style={styles.day} accessibilityRole="header">
      <Text style={[text.meta, text.muted]}>{label}</Text>
    </View>
  )
}

function MessageBubbleView({
  row,
  senderName,
  senderAvatarUrl,
  replyTo,
  replyToName,
  seenByLine,
  onOpenActions,
  onToggleReaction,
  onRetry,
}: MessageBubbleProps) {
  const { message, isMine, position, dayLabel, showTime } = row
  const startsGroup = position === 'first' || position === 'single'
  const endsGroup = position === 'last' || position === 'single'
  const reactions = message.reactions.filter(
    (summary) => summary.count > 0 && !isPollVoteReaction(summary.reaction),
  )
  const wide = message.type === 'image' || message.type === 'video' || message.type === 'poll'

  if (message.type === 'system') {
    return (
      <View style={styles.system}>
        {dayLabel !== null ? <DaySeparator label={dayLabel} /> : null}
        <Text style={[text.meta, text.muted, styles.systemText]}>{message.text ?? ''}</Text>
      </View>
    )
  }

  const openActions = () => {
    lightTap()
    onOpenActions(message)
  }
  const onPress = () => {
    if (message.status === 'failed' && message.clientId !== null) onRetry(message.clientId)
  }
  const statusLabel =
    message.status === 'failed'
      ? `${chatCopy.failedToSend} · ${copy.tapToRetry}`
      : message.status === 'pending'
        ? chatCopy.sending
        : null

  return (
    <View
      style={[
        styles.row,
        startsGroup ? styles.rowStart : styles.rowContinue,
        endsGroup && styles.rowEnd,
      ]}
    >
      {dayLabel !== null ? <DaySeparator label={dayLabel} /> : null}
      <View style={[styles.line, isMine ? styles.lineMine : styles.lineTheirs]}>
        {!isMine ? (
          <View style={styles.faceColumn}>
            {endsGroup ? (
              <Avatar name={senderName} src={senderAvatarUrl} size="small" decorative />
            ) : null}
          </View>
        ) : null}
        <View style={[styles.column, isMine ? styles.columnMine : styles.columnTheirs]}>
          {!isMine && startsGroup ? (
            <Text style={[text.meta, text.muted, styles.senderName]} numberOfLines={1}>
              {senderName}
            </Text>
          ) : null}
          <Pressable
            onPress={onPress}
            onLongPress={openActions}
            delayLongPress={LONG_PRESS_MS}
            accessibilityRole="button"
            accessibilityLabel={`${senderName}: ${messagePreviewText(message.type, message.text)}`}
            accessibilityHint={chatCopy.messageActions}
            accessibilityActions={[{ name: 'longpress', label: chatCopy.messageActions }]}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === 'longpress') openActions()
            }}
            style={[
              styles.bubble,
              wide ? styles.bubbleWide : styles.bubbleText,
              isMine ? styles.bubbleMine : styles.bubbleTheirs,
              message.status === 'pending' && styles.pending,
              message.status === 'failed' && styles.failed,
              !startsGroup && (isMine ? styles.cornerTopRight : styles.cornerTopLeft),
              !endsGroup && (isMine ? styles.cornerBottomRight : styles.cornerBottomLeft),
            ]}
          >
            {replyTo !== null || message.replyToMessageId !== null ? (
              <View style={[styles.quote, isMine ? styles.quoteMine : styles.quoteTheirs]}>
                <Text
                  style={[text.meta, isMine ? styles.inverseMuted : text.muted]}
                  numberOfLines={1}
                >
                  {replyToName}
                </Text>
                <Text
                  style={[text.secondary, isMine ? styles.inverseMuted : text.muted]}
                  numberOfLines={2}
                >
                  {replyTo === null ? '…' : messagePreviewText(replyTo.type, replyTo.text)}
                </Text>
              </View>
            ) : null}
            <MessageBody
              message={message}
              isMine={isMine}
              senderName={senderName}
              onToggleReaction={onToggleReaction}
            />
            {message.editedAt !== null && message.deletedAt === null ? (
              <Text style={[text.meta, isMine ? styles.inverseMuted : text.muted, styles.edited]}>
                {chatCopy.edited}
              </Text>
            ) : null}
          </Pressable>
          {reactions.length > 0 ? (
            <View
              style={[styles.reactions, isMine ? styles.reactionsMine : styles.reactionsTheirs]}
            >
              {reactions.map((summary) => (
                <Pressable
                  key={summary.reaction}
                  onPress={() => {
                    lightTap()
                    onToggleReaction(message.id, summary.reaction)
                  }}
                  accessibilityRole="togglebutton"
                  accessibilityState={{ checked: summary.reactedByMe }}
                  accessibilityLabel={`${summary.reaction} ${summary.count}`}
                  hitSlop={SMALL_ROW_HIT_SLOP}
                  style={[styles.reaction, summary.reactedByMe && styles.reactionMine]}
                >
                  <Text style={[text.meta, text.primary]}>
                    {summary.reaction}
                    {summary.count > 1 ? ` ${summary.count}` : ''}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          {statusLabel !== null ? (
            <Pressable
              onPress={onPress}
              disabled={message.status !== 'failed'}
              accessibilityRole={message.status === 'failed' ? 'button' : 'text'}
              accessibilityLabel={statusLabel}
              hitSlop={SMALL_ROW_HIT_SLOP}
              style={styles.status}
            >
              {message.status === 'failed' ? <View style={styles.failedDot} /> : null}
              <Text style={[text.meta, message.status === 'failed' ? text.danger : text.muted]}>
                {statusLabel}
              </Text>
            </Pressable>
          ) : showTime ? (
            <Text style={[text.meta, text.muted, styles.time]}>
              {timeLabel(message.createdAt)}
              {seenByLine !== null ? ` · ${seenByLine}` : ''}
            </Text>
          ) : seenByLine !== null ? (
            <Text style={[text.meta, text.muted, styles.time]}>{seenByLine}</Text>
          ) : null}
        </View>
      </View>
    </View>
  )
}

export const MessageBubble = memo(MessageBubbleView)

const styles = StyleSheet.create({
  row: { paddingHorizontal: spacing.screenMargin },
  rowStart: { paddingTop: space[3] },
  rowContinue: { paddingTop: space[1] / 2 },
  rowEnd: { paddingBottom: space[1] },
  system: { paddingHorizontal: spacing.screenMargin },
  systemText: { textAlign: 'center', paddingVertical: space[2] },
  day: { alignItems: 'center', justifyContent: 'center', paddingVertical: space[3] },
  line: { flexDirection: 'row', alignItems: 'flex-end', gap: space[2] },
  lineMine: { justifyContent: 'flex-end' },
  lineTheirs: { justifyContent: 'flex-start' },
  faceColumn: { width: avatarSize.small, flexShrink: 0 },
  column: { maxWidth: '78%', minWidth: 0 },
  columnMine: { alignItems: 'flex-end' },
  columnTheirs: { alignItems: 'flex-start' },
  senderName: { marginBottom: space[1], paddingLeft: space[3] },
  bubble: { borderRadius: radius.medium },
  bubbleText: { paddingHorizontal: space[3], paddingVertical: space[2] },
  bubbleWide: { padding: space[1] },
  bubbleMine: { backgroundColor: colors.textPrimary },
  bubbleTheirs: { backgroundColor: colors.subtleFill },
  pending: { opacity: 0.7 },
  failed: { opacity: 0.6 },
  cornerTopRight: { borderTopRightRadius: radius.small },
  cornerTopLeft: { borderTopLeftRadius: radius.small },
  cornerBottomRight: { borderBottomRightRadius: radius.small },
  cornerBottomLeft: { borderBottomLeftRadius: radius.small },
  quote: {
    marginBottom: space[1],
    paddingLeft: space[2],
    borderLeftWidth: borderWidth.indicator,
  },
  quoteMine: { borderLeftColor: colors.textSecondary },
  quoteTheirs: { borderLeftColor: colors.separator },
  inverseMuted: { color: colors.separator },
  edited: { marginTop: space[1] / 2 },
  reactions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[1],
    marginTop: -space[1],
    paddingHorizontal: space[1],
  },
  reactionsMine: { justifyContent: 'flex-end' },
  reactionsTheirs: { justifyContent: 'flex-start' },
  reaction: {
    minHeight: SMALL_ROW_HEIGHT,
    paddingHorizontal: space[2],
    borderRadius: radius.avatar,
    backgroundColor: colors.background,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.separator,
    justifyContent: 'center',
  },
  reactionMine: { borderColor: colors.textPrimary },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    marginTop: space[1],
    minHeight: SMALL_ROW_HEIGHT,
  },
  failedDot: { width: 6, height: 6, borderRadius: radius.avatar, backgroundColor: colors.danger },
  time: { marginTop: space[1] },
})
