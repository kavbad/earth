/**
 * SCREEN 14 group context: the group's existing conversation in a lightweight drawer — the same
 * thread the Chats tab shows (`useConversation` with realtime and the outbox, `MessageList`,
 * `MessageBubble`) behind a plain text composer. Not a separate Live chat (spec: "Do not create
 * a separate public-Live chat for group-only rooms"); the chats surface owns the full experience.
 */
import type { ConversationId, GroupId, HumanId } from '@earth/domain'
import { colors, copy, radius, space } from '@earth/ui'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'

import { MessageBubble } from '@/components/chats/MessageBubble'
import { MessageList } from '@/components/chats/MessageList'
import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { Skeleton } from '@/components/ui/Skeleton'
import { Spinner } from '@/components/ui/Spinner'
import { StatusLine } from '@/components/ui/StatusLine'
import { text } from '@/components/ui/text'
import { displayNameFor, useConversation } from '@/features/chats/hooks/useConversation'
import type { ChatMessage, MessageRow } from '@/features/chats/state/messages'
import { roomCopy } from '@/features/rooms/copy'
import { useRoomShell } from '@/features/rooms/shell'
import { lightTap } from '@/lib/haptics'

export interface GroupChatDrawerProps {
  readonly open: boolean
  readonly groupId: GroupId
  readonly title: string
  readonly onClose: () => void
}

const noActions = (_message: ChatMessage): void => undefined

function DrawerThread({
  conversationId,
  title,
}: {
  readonly conversationId: ConversationId
  readonly title: string
}) {
  const controller = useConversation(conversationId)
  const { rows, messages, membersById, viewerId, loadStatus, hasOlder, loadingOlder, connection } =
    controller
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendFailed, setSendFailed] = useState(false)

  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])
  const nameOf = useCallback(
    (humanId: HumanId) => displayNameFor(humanId, membersById, viewerId, copy.human),
    [membersById, viewerId],
  )
  const renderRow = useCallback(
    (row: MessageRow) => {
      const reply =
        row.message.replyToMessageId === null
          ? null
          : (byId.get(row.message.replyToMessageId) ?? null)
      return (
        <MessageBubble
          row={row}
          senderName={nameOf(row.message.senderHumanId)}
          senderAvatarUrl={membersById.get(row.message.senderHumanId)?.avatarUrl ?? null}
          replyTo={reply}
          replyToName={reply === null ? '' : nameOf(reply.senderHumanId)}
          seenByLine={null}
          onOpenActions={noActions}
          onToggleReaction={controller.toggleReaction}
          onRetry={controller.retry}
        />
      )
    },
    [byId, nameOf, membersById, controller.toggleReaction, controller.retry],
  )

  const submit = async () => {
    const body = draft.trim()
    if (body.length === 0 || sending) return
    lightTap()
    setDraft('')
    setSending(true)
    setSendFailed(false)
    try {
      await controller.send({ type: 'text', text: body, replyToMessageId: null })
    } catch {
      setSendFailed(true)
    } finally {
      setSending(false)
    }
  }

  return (
    <View style={styles.body}>
      <View style={styles.thread}>
        {loadStatus === 'error' && rows.length === 0 ? (
          <StatusLine
            message={connection.online ? copy.couldntRefresh : copy.waitingForConnection}
            actionLabel={roomCopy.retry}
            onAction={controller.reload}
          />
        ) : loadStatus === 'loading' || loadStatus === 'idle' ? (
          <Spinner fill label={title} />
        ) : (
          <MessageList
            rows={rows}
            renderRow={renderRow}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
            onLoadOlder={() => void controller.loadOlder()}
            label={title}
            emptyLine={roomCopy.noMessagesYet}
          />
        )}
      </View>
      {!connection.online ? <StatusLine banner message={copy.waitingForConnection} /> : null}
      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={(value) => {
            setDraft(value)
            controller.noteTyping()
          }}
          placeholder={copy.messagePlaceholder}
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel={copy.messagePlaceholder}
          returnKeyType="send"
          blurOnSubmit={false}
          onSubmitEditing={() => void submit()}
          style={[text.body, text.primary, styles.input]}
        />
        <Button
          variant="primary"
          compact
          loading={sending}
          disabled={draft.trim().length === 0}
          label={roomCopy.send}
          onPress={() => void submit()}
        />
      </View>
      {sendFailed ? <StatusLine message={roomCopy.somethingWrong} danger /> : null}
    </View>
  )
}

function DrawerBody({ groupId, title }: { readonly groupId: GroupId; readonly title: string }) {
  const { earth, ready } = useRoomShell()
  const group = useQuery({
    queryKey: ['rooms', 'group', groupId],
    queryFn: () => earth.groups.get(groupId),
    enabled: ready,
    staleTime: 5 * 60_000,
  })
  if (group.isError) {
    return (
      <StatusLine
        message={copy.couldntRefresh}
        actionLabel={roomCopy.retry}
        onAction={() => void group.refetch()}
      />
    )
  }
  const conversationId = group.data?.conversationId ?? null
  if (conversationId === null) {
    return (
      <View style={styles.skeleton} accessibilityLabel={title}>
        <Skeleton width="66%" height={space[5]} />
        <Skeleton width="50%" height={space[5]} />
      </View>
    )
  }
  return <DrawerThread key={conversationId} conversationId={conversationId} title={title} />
}

export function GroupChatDrawer({ open, groupId, title, onClose }: GroupChatDrawerProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title} closeButton avoidKeyboard>
      {open ? <DrawerBody groupId={groupId} title={title} /> : null}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { gap: space[3] },
  thread: { height: 360 },
  skeleton: { gap: space[3], paddingVertical: space[4] },
  composer: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  input: {
    flex: 1,
    minHeight: space[10] + space[1],
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderRadius: radius.medium,
    backgroundColor: colors.subtleFill,
  },
})
