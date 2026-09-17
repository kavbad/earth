'use client'

/**
 * SCREEN 10 (group chat) and SCREEN 11 (DM): header, the windowed thread, the composer with its
 * sheets, and the actions sheet. Sending, media, voice and the camera → room hand-off live here;
 * data and realtime are `useConversation`.
 */
import type { PlaceDto } from '@earth/domain'
import { copy } from '@earth/ui'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { webCopy } from '../../lib/copy'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useFlags } from '../../lib/providers/FlagsProvider'
import { useEarth } from '../../lib/providers/RuntimeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { useToast } from '../ui/Toast'
import { LoadingState } from '../shell/LoadingState'
import { PageContainer } from '../shell/PageContainer'
import { ScreenHeader } from '../shell/ScreenHeader'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Spinner } from '../ui/Spinner'
import { ClaimToChat } from './ChatsList'
import { Composer } from './Composer'
import { ConversationHeader } from './ConversationHeader'
import { HereSheet } from './HereSheet'
import { MessageActions } from './MessageActions'
import { MessageBubble, displayNameFor } from './MessageBubble'
import { MessageList } from './MessageList'
import { PlaceSheet } from './PlaceSheet'
import { PlusSheet, type PlusAction } from './PlusSheet'
import { PollComposer } from './PollComposer'
import { chatCopy } from './copy'
import { useActiveRoomNames } from './hooks/useActiveRoomNames'
import { type ConversationController, useConversation } from './hooks/useConversation'
import { useVoiceRecorder } from './hooks/useVoiceRecorder'
import {
  mediaPayload,
  messageTypeForFile,
  normalizeContentType,
  placePayload,
  pollPayload,
} from './payloads'
import { roomRoute } from './routes'
import type { ChatMessage, MessageRow } from './state/messages'
import { seenByNames } from './state/read'
import { STORAGE_BUCKETS } from '@earth/api'
import type { ConversationId } from '@earth/domain'

type Sheet = 'none' | 'plus' | 'poll' | 'place' | 'here'

interface ThreadRow extends MessageRow {
  readonly key: string
}

/** Pixel size of an image file, for the media row (`null` when the browser cannot decode it). */
function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    if (!file.type.startsWith('image/') || typeof URL === 'undefined') {
      resolve(null)
      return
    }
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    image.src = url
  })
}

export interface ConversationScreenProps {
  readonly conversationId: ConversationId
}

export function ConversationScreen({ conversationId }: ConversationScreenProps) {
  const session = useSession()
  const controller = useConversation(conversationId)
  if (session.status === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center py-16">
        <Spinner />
      </div>
    )
  }
  if (session.roleKind !== 'human') {
    return (
      <>
        <ScreenHeader title={copy.chats} />
        <PageContainer>
          <ClaimToChat title={chatCopy.couldntSendVisitor} />
        </PageContainer>
      </>
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
  const earth = useEarth()
  const flags = useFlags()
  const analytics = useAnalytics()
  const toast = useToast()
  const router = useRouter()
  const recorder = useVoiceRecorder()
  const [sheet, setSheet] = useState<Sheet>('none')
  const [actionsFor, setActionsFor] = useState<ChatMessage | null>(null)
  const [uploading, setUploading] = useState(false)
  const [cameraBusy, setCameraBusy] = useState(false)
  const photoInput = useRef<HTMLInputElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const live = useActiveRoomNames(
    conversation?.activeRoom?.roomId ?? null,
    conversation?.activeRoom?.participantCount ?? 0,
  )

  const byId = useMemo(() => new Map(messages.map((message) => [message.id, message])), [messages])
  const threadRows = useMemo<ThreadRow[]>(
    () => rows.map((row) => ({ ...row, key: row.message.id })),
    [rows],
  )
  const members = conversation?.members ?? []
  const seenByLine = seenBy === null ? null : chatCopy.seenBy(seenByNames(seenBy.humanIds, members))
  const nameOf = useCallback(
    (humanId: ChatMessage['senderHumanId']) => displayNameFor(humanId, membersById, viewerId),
    [membersById, viewerId],
  )
  const eventContext = () =>
    conversation?.groupId === null || conversation === undefined
      ? { conversationId, conversationType: conversation?.type ?? ('direct' as const) }
      : { conversationId, conversationType: conversation.type, groupId: conversation.groupId }

  const sendFiles = async (files: readonly File[]) => {
    if (files.length === 0) return
    setUploading(true)
    let sentCount = 0
    let mediaType: 'image' | 'video' | null = null
    try {
      for (const file of files) {
        const contentType = normalizeContentType(file.type)
        const type = messageTypeForFile(contentType)
        const size = type === 'image' ? await imageSize(file) : null
        const media = await earth.media.upload(file, {
          bucket: STORAGE_BUCKETS.media,
          contentType,
          width: size?.width ?? null,
          height: size?.height ?? null,
          byteSize: file.size,
        })
        await controller.send({
          type,
          text: null,
          payload: mediaPayload(media, {
            width: size?.width ?? null,
            height: size?.height ?? null,
            byteSize: file.size,
            name: type === 'file' ? file.name : null,
          }),
          replyToMessageId: replyTo?.id ?? null,
        })
        sentCount += 1
        if (type !== 'file') mediaType = type
      }
      if (mediaType !== null) {
        analytics.track('media_message_sent', { ...eventContext(), mediaType, count: sentCount })
      }
      controller.setReplyTo(null)
    } catch {
      toast.show(chatCopy.uploadFailed)
    } finally {
      setUploading(false)
    }
  }

  const stopRecording = async () => {
    const recording = await recorder.stop()
    if (recording === null) return
    setUploading(true)
    try {
      const media = await earth.media.upload(recording.blob, {
        bucket: STORAGE_BUCKETS.voice,
        contentType: recording.contentType,
        durationMs: Math.round(recording.durationMs),
        byteSize: recording.blob.size,
      })
      await controller.send({
        type: 'audio',
        text: null,
        payload: mediaPayload(media, {
          durationMs: Math.round(recording.durationMs),
          byteSize: recording.blob.size,
        }),
        replyToMessageId: replyTo?.id ?? null,
      })
      controller.setReplyTo(null)
      analytics.track('voice_message_sent', {
        ...eventContext(),
        durationMs: Math.round(recording.durationMs),
      })
    } catch {
      toast.show(chatCopy.uploadFailed)
    } finally {
      setUploading(false)
    }
  }

  const startRecording = async () => {
    await recorder.start()
  }
  const recorderStatus = recorder.status
  const cancelRecording = recorder.cancel
  useEffect(() => {
    if (recorderStatus !== 'unavailable') return
    // Said once; the recorder resets so the next tap asks again.
    toast.show(chatCopy.microphoneUnavailable)
    cancelRecording()
  }, [recorderStatus, cancelRecording, toast])

  const onCamera = async () => {
    if (conversation === undefined) return
    const activeRoomId = conversation.activeRoom?.roomId ?? null
    if (activeRoomId !== null) {
      router.push(roomRoute(activeRoomId))
      return
    }
    setCameraBusy(true)
    try {
      const started = await earth.rooms.start(
        conversation.type === 'group' && conversation.groupId !== null
          ? { contextType: 'group', contextId: conversation.groupId }
          : { contextType: 'direct', contextId: conversation.id },
      )
      if (started.created) {
        analytics.track('room_created', {
          roomId: started.room.id,
          contextType: started.room.contextType,
          ...(conversation.groupId === null ? {} : { groupId: conversation.groupId }),
          visibility: started.room.visibility,
          joinPolicy: started.room.joinPolicy,
        })
      }
      router.push(roomRoute(started.room.id))
    } catch {
      toast.show(webCopy.somethingWrong)
      setCameraBusy(false)
    }
  }

  const onPlus = (action: PlusAction) => {
    switch (action) {
      case 'photoVideo':
        photoInput.current?.click()
        return
      case 'file':
        fileInput.current?.click()
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

  const sendText = (text: string) => {
    void controller.send({ type: 'text', text, replyToMessageId: replyTo?.id ?? null })
    controller.setReplyTo(null)
  }

  const sendPoll = (question: string, options: readonly string[]) => {
    void controller.send({ type: 'poll', text: question, payload: pollPayload(question, options) })
  }

  const sendPlace = (place: PlaceDto) => {
    void controller.send({ type: 'place', text: place.name, payload: placePayload(place) })
  }

  const renderRow = useCallback(
    (row: ThreadRow) => {
      const reply =
        row.message.replyToMessageId === null
          ? null
          : (byId.get(row.message.replyToMessageId) ?? null)
      return (
        <MessageBubble
          row={row}
          senderName={nameOf(row.message.senderHumanId)}
          sender={membersById.get(row.message.senderHumanId)}
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
    conversation?.activeRoom === null || conversation === undefined
      ? chatCopy.startVideo
      : chatCopy.joinVideo

  return (
    <div className="flex h-[calc(100dvh-var(--earth-space-16)-env(safe-area-inset-bottom))] min-h-0 flex-col overflow-hidden rail:h-dvh">
      <ConversationHeader
        conversationId={conversationId}
        conversation={conversation}
        presence={presence}
        liveCount={live.total}
      />
      {connection.degraded ? (
        <div
          role="status"
          className="bg-subtle-fill px-screen-margin py-2 text-center text-meta text-text-secondary"
        >
          {copy.waitingForConnection}
        </div>
      ) : null}
      <PageContainer className="flex min-h-0 flex-1 flex-col">
        {conversationStatus === 'error' ? (
          // Spec §107: offline this reads "Waiting for connection", not a verdict on the chat.
          <LoadingState>
            <EmptyState
              title={chatCopy.conversationUnavailable}
              action={
                <Button variant="secondary" onClick={controller.refreshConversation}>
                  {webCopy.retry}
                </Button>
              }
            />
          </LoadingState>
        ) : loadStatus === 'error' && messages.length === 0 ? (
          <LoadingState>
            <EmptyState
              title={copy.couldntRefresh}
              action={
                <Button variant="secondary" onClick={controller.reload}>
                  {webCopy.retry}
                </Button>
              }
            />
          </LoadingState>
        ) : loadStatus === 'loading' || loadStatus === 'idle' ? (
          <LoadingState>
            <div className="flex flex-1 items-center justify-center py-16">
              <Spinner />
            </div>
          </LoadingState>
        ) : (
          <MessageList
            rows={threadRows}
            renderRow={renderRow}
            hasOlder={hasOlder}
            loadingOlder={loadingOlder}
            onLoadOlder={() => void controller.loadOlder()}
            label={title}
            header={
              messages.length === 0 ? (
                <span className="text-secondary text-text-secondary">{chatCopy.noMessagesYet}</span>
              ) : null
            }
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
          recording={{
            active: recorder.status === 'recording' || recorder.status === 'requesting',
            elapsedMs: recorder.elapsedMs,
            supported: recorder.supported,
            start: () => void startRecording(),
            stop: () => void stopRecording(),
            cancel: recorder.cancel,
          }}
        />
      </PageContainer>
      <input
        ref={photoInput}
        type="file"
        accept="image/*,video/*"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          void sendFiles(files)
        }}
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          event.target.value = ''
          void sendFiles(files)
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
      />
    </div>
  )
}
