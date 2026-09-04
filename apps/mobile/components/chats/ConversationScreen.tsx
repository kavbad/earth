/**
 * SCREEN 10 (group chat) and SCREEN 11 (DM): header, the inverted thread, the composer with its
 * sheets, and the actions sheet. Sending, media, voice and the camera → room hand-off live here;
 * data and realtime are `useConversation`. Offline the thread stays readable and sends queue
 * (spec §107); a failed send says "Tap to retry" (spec §108).
 */
import { STORAGE_BUCKETS } from '@earth/api'
import type { ConversationId, MediaType, PlaceDto } from '@earth/domain'
import { copy } from '@earth/ui'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  Button,
  EmptyState,
  IconButton,
  Screen,
  ScreenHeader,
  Spinner,
  StatusLine,
} from '@/components/ui'
import { chatCopy } from '@/features/chats/copy'
import { useActiveRoomNames } from '@/features/chats/hooks/useActiveRoomNames'
import {
  type ConversationController,
  displayNameFor,
  useConversation,
} from '@/features/chats/hooks/useConversation'
import { useVoiceRecorder } from '@/features/chats/hooks/useVoiceRecorder'
import { type PickedMedia, pickPhotosAndVideos, readFileBody } from '@/features/chats/media'
import { mediaPayload, placePayload, pollPayload } from '@/features/chats/payloads'
import { CHATS_ROUTE, conversationInfoRoute, roomRoute } from '@/features/chats/routes'
import { useChatsShell } from '@/features/chats/shell'
import type { ChatMessage, MessageRow } from '@/features/chats/state/messages'
import { seenByNames } from '@/features/chats/state/read'
import { useStartRoom } from '@/features/rooms/hooks/useStartRoom'
import { lightTap } from '@/lib/haptics'

import { ClaimToChat } from './ClaimToChat'
import { Composer } from './Composer'
import { ConversationHeader } from './ConversationHeader'
import { HereSheet } from './HereSheet'
import { MessageActions } from './MessageActions'
import { MessageBubble } from './MessageBubble'
import { MessageList } from './MessageList'
import { PlaceSheet } from './PlaceSheet'
import { type PlusAction, PlusSheet } from './PlusSheet'
import { PollComposer } from './PollComposer'

type SheetName = 'none' | 'plus' | 'poll' | 'place' | 'here'

export interface ConversationScreenProps {
  readonly conversationId: ConversationId
}

export function ConversationScreen({ conversationId }: ConversationScreenProps) {
  const shell = useChatsShell()
  const router = useRouter()
  const controller = useConversation(conversationId)
  // A pushed screen always keeps its way back, whoever is looking at it.
  const back = () => {
    if (router.canGoBack()) router.back()
    else router.replace(CHATS_ROUTE)
  }
  if (shell.sessionStatus === 'loading') {
    return (
      <Screen edges={['top']}>
        <Spinner fill label={copy.chats} />
      </Screen>
    )
  }
  if (!shell.isHuman) {
    return (
      <Screen>
        <ScreenHeader
          title={copy.chats}
          leading={<IconButton name="back" label={chatCopy.back} onPress={back} />}
        />
        <ClaimToChat title={chatCopy.couldntSendVisitor} />
      </Screen>
    )
  }
  return <Thread controller={controller} />
}

function Thread({ controller }: { readonly controller: ConversationController }) {
  const {
    conversationId,
    conversation,
    conversationStatus,
    membersById,
    messages,
    rows,
    loadStatus,
    hasOlder,
    loadingOlder,
    connection,
    presence,
    seenBy,
    replyTo,
    viewerId,
  } = controller
  const shell = useChatsShell()
  const { earth, flags, track, toast } = shell
  const router = useRouter()
  const startRoom = useStartRoom()
  const recorder = useVoiceRecorder()
  const [sheet, setSheet] = useState<SheetName>('none')
  const [actionsFor, setActionsFor] = useState<ChatMessage | null>(null)
  const [uploading, setUploading] = useState(false)
  const [cameraBusy, setCameraBusy] = useState(false)
  const live = useActiveRoomNames(
    conversation?.activeRoom?.roomId ?? null,
    conversation?.activeRoom?.participantCount ?? 0,
  )

  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])
  const members = conversation?.members ?? []
  const seenByLine = seenBy === null ? null : chatCopy.seenBy(seenByNames(seenBy.humanIds, members))
  const nameOf = useCallback(
    (humanId: ChatMessage['senderHumanId']) =>
      displayNameFor(humanId, membersById, viewerId, copy.human),
    [membersById, viewerId],
  )
  const eventContext = useCallback(
    () =>
      conversation === undefined || conversation.groupId === null
        ? { conversationId, conversationType: conversation?.type ?? ('direct' as const) }
        : { conversationId, conversationType: conversation.type, groupId: conversation.groupId },
    [conversation, conversationId],
  )

  const sendMedia = async (picked: readonly PickedMedia[]) => {
    if (picked.length === 0) return
    setUploading(true)
    let sentCount = 0
    let mediaType: MediaType | null = null
    try {
      for (const item of picked) {
        const body = await readFileBody(item.uri)
        const byteSize = item.byteSize ?? body.byteLength
        const media = await earth.media.upload(body, {
          bucket: STORAGE_BUCKETS.media,
          contentType: item.contentType,
          width: item.width,
          height: item.height,
          durationMs: item.durationMs,
          byteSize,
        })
        await controller.send({
          type: item.type,
          text: null,
          payload: mediaPayload(media, {
            width: item.width,
            height: item.height,
            durationMs: item.durationMs,
            byteSize,
            name: item.type === 'file' ? item.name : null,
          }),
          replyToMessageId: replyTo?.id ?? null,
        })
        sentCount += 1
        if (item.type !== 'file') mediaType = item.type
      }
      if (mediaType !== null) {
        track('media_message_sent', { ...eventContext(), mediaType, count: sentCount })
      }
      controller.setReplyTo(null)
    } catch {
      toast(chatCopy.uploadFailed)
    } finally {
      setUploading(false)
    }
  }

  const pickPhotos = async () => {
    const result = await pickPhotosAndVideos()
    if (result.status === 'denied') {
      toast(chatCopy.photosPermission)
      return
    }
    if (result.status === 'picked') await sendMedia(result.media)
  }

  const stopRecording = async () => {
    const recording = await recorder.stop()
    if (recording === null) return
    setUploading(true)
    try {
      const body = await readFileBody(recording.uri)
      const media = await earth.media.upload(body, {
        bucket: STORAGE_BUCKETS.voice,
        contentType: recording.contentType,
        durationMs: recording.durationMs,
        byteSize: body.byteLength,
      })
      await controller.send({
        type: 'audio',
        text: null,
        payload: mediaPayload(media, {
          durationMs: recording.durationMs,
          byteSize: body.byteLength,
        }),
        replyToMessageId: replyTo?.id ?? null,
      })
      controller.setReplyTo(null)
      lightTap()
      track('voice_message_sent', { ...eventContext(), durationMs: recording.durationMs })
    } catch {
      toast(chatCopy.uploadFailed)
    } finally {
      setUploading(false)
    }
  }

  const recorderStatus = recorder.status
  const resetRecorder = recorder.reset
  useEffect(() => {
    if (recorderStatus !== 'unavailable') return
    // Said once; the recorder resets so the next tap asks again.
    toast(chatCopy.microphoneUnavailable)
    resetRecorder()
  }, [recorderStatus, resetRecorder, toast])

  // Spec §57: no active room → start the group (or direct) video; an active room → join it.
  const onCamera = async () => {
    if (conversation === undefined) return
    lightTap()
    const activeRoomId = conversation.activeRoom?.roomId ?? null
    if (activeRoomId !== null) {
      router.push(roomRoute(activeRoomId))
      return
    }
    setCameraBusy(true)
    try {
      await startRoom(
        conversation.type === 'group' && conversation.groupId !== null
          ? { contextType: 'group', contextId: conversation.groupId }
          : { contextType: 'direct', contextId: conversation.id },
      )
    } catch {
      toast(chatCopy.somethingWrong)
    } finally {
      setCameraBusy(false)
    }
  }

  const onPlus = (action: PlusAction) => {
    switch (action) {
      case 'photoVideo':
        void pickPhotos()
        return
      case 'file':
        // Hidden while no document picker is installed (`FILE_PICKER_AVAILABLE`).
        return
      case 'poll':
        setSheet('poll')
        return
      case 'place':
        setSheet('place')
        return
      case 'here':
        setSheet('here')
        return
      default: {
        const exhaustive: never = action
        throw new Error(String(exhaustive))
      }
    }
  }

  const sendText = (value: string) => {
    void controller.send({ type: 'text', text: value, replyToMessageId: replyTo?.id ?? null })
    controller.setReplyTo(null)
  }
  const sendPoll = (question: string, options: readonly string[]) => {
    lightTap()
    void controller.send({ type: 'poll', text: question, payload: pollPayload(question, options) })
  }
  const sendPlace = (place: PlaceDto) => {
    lightTap()
    void controller.send({ type: 'place', text: place.name, payload: placePayload(place) })
  }

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
          seenByLine={seenBy !== null && seenBy.messageId === row.message.id ? seenByLine : null}
          onOpenActions={setActionsFor}
          onToggleReaction={controller.toggleReaction}
          onRetry={controller.retry}
        />
      )
    },
    [byId, nameOf, membersById, seenBy, seenByLine, controller.toggleReaction, controller.retry],
  )

  const title = conversation?.title ?? ''
  const cameraLabel =
    conversation === undefined || conversation.activeRoom === null
      ? chatCopy.startVideo
      : chatCopy.joinVideo
  const back = () => {
    if (router.canGoBack()) router.back()
    else router.replace(CHATS_ROUTE)
  }

  return (
    <Screen avoidKeyboard accessibilityLabel={title}>
      <ConversationHeader
        conversation={conversation}
        presence={presence}
        liveCount={live.total}
        onBack={back}
        onOpenInfo={() => router.push(conversationInfoRoute(conversationId))}
        onJoinRoom={() => {
          const roomId = conversation?.activeRoom?.roomId
          if (roomId !== undefined) router.push(roomRoute(roomId))
        }}
      />
      {!connection.online || connection.degraded ? (
        <StatusLine banner message={copy.waitingForConnection} />
      ) : null}
      {conversationStatus === 'error' ? (
        <EmptyState
          title={connection.online ? chatCopy.conversationUnavailable : copy.couldntRefresh}
          action={
            <Button
              variant="secondary"
              label={chatCopy.retry}
              onPress={controller.refreshConversation}
            />
          }
        />
      ) : loadStatus === 'error' && messages.length === 0 ? (
        <EmptyState
          title={copy.couldntRefresh}
          action={<Button variant="secondary" label={chatCopy.retry} onPress={controller.reload} />}
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
          emptyLine={chatCopy.noMessagesYet}
        />
      )}
      <Composer
        disabled={conversationStatus !== 'ready'}
        replyTo={replyTo}
        replyToName={replyTo === null ? '' : nameOf(replyTo.senderHumanId)}
        onCancelReply={() => controller.setReplyTo(null)}
        onSendText={sendText}
        onTyping={controller.noteTyping}
        onPlus={() => setSheet('plus')}
        onCamera={() => void onCamera()}
        cameraLabel={cameraLabel}
        cameraBusy={cameraBusy}
        uploading={uploading}
        placeholder={copy.messagePlaceholder}
        recording={{
          active: recorder.status === 'recording' || recorder.status === 'requesting',
          elapsedMs: recorder.elapsedMs,
          supported: recorder.supported,
          start: () => {
            lightTap()
            void recorder.start()
          },
          stop: () => void stopRecording(),
          cancel: recorder.cancel,
        }}
      />
      <PlusSheet
        open={sheet === 'plus'}
        locationSharingEnabled={flags.LOCATION_SHARING_ENABLED}
        onClose={() => setSheet('none')}
        onPick={onPlus}
      />
      <PollComposer open={sheet === 'poll'} onClose={() => setSheet('none')} onCreate={sendPoll} />
      <PlaceSheet open={sheet === 'place'} onClose={() => setSheet('none')} onPick={sendPlace} />
      <HereSheet
        open={sheet === 'here'}
        onClose={() => setSheet('none')}
        conversationId={conversationId}
        conversationTitle={title}
      />
      <MessageActions
        message={actionsFor}
        isMine={actionsFor !== null && actionsFor.senderHumanId === viewerId}
        seenBy={seenBy}
        members={members}
        onClose={() => setActionsFor(null)}
        onReact={controller.toggleReaction}
        onReply={controller.setReplyTo}
        onDelete={(id) => void controller.deleteMessage(id)}
        onRetry={controller.retry}
        onDiscard={controller.discard}
        onCopied={() => toast(chatCopy.textCopied)}
      />
    </Screen>
  )
}
