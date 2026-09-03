'use client'

/**
 * Everything one open conversation needs (SCREEN 10/11; spec §53–§55, §107–§108):
 *
 * - `conversation_get` for the header and members, `messages_list` pages into the message store;
 * - `subscribeConversation` (realtime with the polling fallback) from the newest loaded message;
 * - the `@earth/realtime` outbox for optimistic sends — idempotent on `clientId`, persisted on the
 *   device, flushed when the connection returns, `failed` → "Tap to retry";
 * - presence (typing / active) on `conversation:<id>` and the `presence_ping` scheduler;
 * - `conversation_mark_read` when the newest message is on screen, and read receipts for "Seen by".
 *
 * Mount it under a component keyed by the conversation id so a navigation between chats remounts
 * the store instead of merging two threads.
 */
import { createRealtimeFactories } from '@earth/api'
import type { AnalyticsEventMap } from '@earth/analytics'
import {
  type ConversationDetailDto,
  type ConversationId,
  type ConversationMemberDto,
  type HumanId,
  type JsonObject,
  type MessageDto,
  type MessageId,
  type MessageType,
  type RoomId,
} from '@earth/domain'
import {
  type ConversationSubscription,
  type Outbox,
  type PresenceHandle,
  type PresencePeer,
  type RealtimeMode,
  createOutbox,
  createPresencePinger,
  joinPresence,
  subscribeConversation,
} from '@earth/realtime'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'

import { useAnalytics } from '../../../lib/providers/AnalyticsProvider'
import { useOnline } from '../../../lib/providers/OfflineProvider'
import { useEarth, useRuntime } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'
import { localStore } from '../../../lib/storage'
import { chatCopy } from '../copy'
import { createChatDiagnostics } from '../realtime'
import {
  type ChatMessage,
  INITIAL_MESSAGES_STATE,
  type MessageRow,
  annotateMessages,
  messagesReducer,
  newestSentMessageId,
  oldestSentMessageId,
} from '../state/messages'
import { createOutboxStorage } from '../state/outboxStorage'
import {
  MARK_READ_DEBOUNCE_MS,
  type SeenBy,
  mergeReadPointers,
  messageIdToMarkRead,
  seenByFor,
  withUnreadCleared,
} from '../state/read'
import { CONVERSATIONS_QUERY_KEY } from './useConversationsList'

export const READ_RECEIPTS_INTERVAL_MS = 30_000
/** How often a keystroke re-announces typing (presence expires it after `TYPING_TTL_MS`). */
export const TYPING_ANNOUNCE_MS = 2_000

export type ConversationLoadStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SendMessageInput {
  readonly type: Exclude<MessageType, 'system'>
  readonly text: string | null
  readonly payload?: JsonObject
  readonly replyToMessageId?: MessageId | null
}

export interface ConversationConnection {
  readonly online: boolean
  readonly mode: RealtimeMode
  /** The channel is down and the polling fallback is failing too. */
  readonly degraded: boolean
}

export interface ConversationPresence {
  readonly typingNames: readonly string[]
  readonly activeNames: readonly string[]
}

export interface ConversationController {
  readonly conversationId: ConversationId
  readonly viewerId: HumanId | null
  readonly conversation: ConversationDetailDto | undefined
  readonly conversationStatus: 'loading' | 'ready' | 'error'
  readonly membersById: ReadonlyMap<HumanId, ConversationMemberDto>
  readonly messages: readonly ChatMessage[]
  readonly rows: readonly MessageRow[]
  readonly loadStatus: ConversationLoadStatus
  readonly hasOlder: boolean
  readonly loadingOlder: boolean
  readonly connection: ConversationConnection
  readonly presence: ConversationPresence
  readonly seenBy: SeenBy | null
  readonly replyTo: ChatMessage | null
  readonly activeRoomId: RoomId | null
  reload(): void
  loadOlder(): Promise<void>
  send(input: SendMessageInput): Promise<void>
  retry(clientId: string): void
  discard(clientId: string): void
  toggleReaction(messageId: MessageId, reaction: string): void
  deleteMessage(messageId: MessageId): Promise<void>
  setReplyTo(message: ChatMessage | null): void
  noteTyping(): void
  refreshConversation(): void
}

function messageEventContext(
  conversation: ConversationDetailDto | undefined,
  conversationId: ConversationId,
): Pick<AnalyticsEventMap['message_sent'], 'conversationId' | 'conversationType' | 'groupId'> {
  const type = conversation?.type ?? 'direct'
  const groupId = conversation?.groupId ?? null
  return groupId === null
    ? { conversationId, conversationType: type }
    : { conversationId, conversationType: type, groupId }
}

function randomClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // RFC 4122 v4 from `getRandomValues` for older WebViews.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const b6 = ((bytes[6] ?? 0) & 0x0f) | 0x40
  const b8 = ((bytes[8] ?? 0) & 0x3f) | 0x80
  bytes[6] = b6
  bytes[8] = b8
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible'
}

export function useConversation(conversationId: ConversationId): ConversationController {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const session = useSession()
  const online = useOnline()
  const analytics = useAnalytics()
  const queryClient = useQueryClient()
  const viewerId = session.humanId
  const enabled = runtime !== null && session.status === 'ready' && viewerId !== null

  // ------------------------------------------------------------------ conversation detail
  const detail = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => earth.conversations.get(conversationId),
    enabled,
  })
  const conversation = detail.data
  const conversationRef = useRef(conversation)
  useEffect(() => {
    conversationRef.current = conversation
  }, [conversation])
  const membersById = useMemo(
    () => new Map((conversation?.members ?? []).map((member) => [member.humanId, member])),
    [conversation],
  )

  // ------------------------------------------------------------------ message store
  const [state, dispatch] = useReducer(messagesReducer, INITIAL_MESSAGES_STATE)
  // 'loading' until the first page answers; `reload()` puts it back before the next attempt.
  const [loadStatus, setLoadStatus] = useState<ConversationLoadStatus>('loading')
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const messagesRef = useRef(state.messages)
  useEffect(() => {
    messagesRef.current = state.messages
  }, [state.messages])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    earth.conversations.messages
      .list({ conversationId })
      .then((page) => {
        if (cancelled) return
        dispatch({
          type: 'page',
          messages: page.messages,
          nextCursor: page.nextCursor,
          initial: true,
        })
        setLoadStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setLoadStatus('error')
      })
    return () => {
      cancelled = true
    }
  }, [enabled, earth, conversationId, reloadTick])

  const loadOlder = useCallback(async () => {
    const beforeId = state.nextCursor ?? oldestSentMessageId(messagesRef.current)
    if (!enabled || loadingOlder || beforeId === null || !state.loaded) return
    setLoadingOlder(true)
    try {
      const page = await earth.conversations.messages.list({ conversationId, beforeId })
      dispatch({
        type: 'page',
        messages: page.messages,
        nextCursor: page.nextCursor,
        initial: false,
      })
    } catch {
      // The "earlier messages" control stays; the next tap tries again.
    } finally {
      setLoadingOlder(false)
    }
  }, [enabled, earth, conversationId, loadingOlder, state.nextCursor, state.loaded])

  // ------------------------------------------------------------------ realtime
  const [mode, setMode] = useState<RealtimeMode>('realtime')
  const [pollFailing, setPollFailing] = useState(false)
  const subscriptionRef = useRef<ConversationSubscription | null>(null)
  const receiptsRefetch = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!enabled || runtime === null || loadStatus !== 'ready') return
    const factories = createRealtimeFactories(earth)
    const fetchSince = factories.fetchSince(conversationId)
    const subscription = subscribeConversation({
      supabase: runtime.supabase,
      conversationId,
      lastSeenMessageId: newestSentMessageId(messagesRef.current),
      diagnostics: createChatDiagnostics(earth),
      fetchSince: async (afterId) => {
        try {
          const messages = await fetchSince(afterId)
          setPollFailing(false)
          return messages
        } catch (error) {
          setPollFailing(true)
          throw error
        }
      },
      onMessage: (message, change) => {
        dispatch({ type: 'received', message, change })
        if (change === 'inserted' && message.senderHumanId !== viewerId) {
          const latency = Date.now() - Date.parse(message.createdAt)
          analytics.track('message_received', {
            ...messageEventContext(conversationRef.current, conversationId),
            type: message.type,
            via: subscription.mode() === 'polling' ? 'poll' : 'realtime',
            deliveryLatencyMs: Number.isFinite(latency) ? Math.max(0, latency) : 0,
          })
          receiptsRefetch.current?.()
        }
      },
      onReaction: (event) => dispatch({ type: 'reaction', event, viewerHumanId: viewerId }),
      onStatus: (status) => setMode(status.mode),
    })
    subscriptionRef.current = subscription
    const onVisible = () => {
      if (isDocumentVisible()) void subscription.refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      subscription.unsubscribe()
      subscriptionRef.current = null
    }
  }, [enabled, runtime, earth, conversationId, loadStatus, viewerId, analytics])

  // Back online: close the gap the channel missed.
  useEffect(() => {
    if (online) void subscriptionRef.current?.refresh()
  }, [online])

  // ------------------------------------------------------------------ outbox
  const onlineRef = useRef(online)
  useEffect(() => {
    onlineRef.current = online
  }, [online])
  const failedRef = useRef<ReadonlySet<string>>(new Set())
  // Created in an effect (it reads refs and storage); handlers reach it through the ref.
  const outboxRef = useRef<Outbox | null>(null)

  useEffect(() => {
    if (viewerId === null || runtime === null) return
    const outbox = createOutbox({
      storage: createOutboxStorage(localStore(), viewerId, conversationId),
      senderHumanId: viewerId,
      isOnline: () => onlineRef.current,
      diagnostics: createChatDiagnostics(earth),
      send: (item) => earth.conversations.messages.send(item.input),
      onSent: (message, item) => {
        dispatch({ type: 'sent', clientId: item.clientId, message })
        analytics.track('message_sent', {
          ...messageEventContext(conversationRef.current, conversationId),
          type: message.type,
          isReply: message.replyToMessageId !== null,
          outcome: 'sent',
        })
      },
    })
    outboxRef.current = outbox
    const unsubscribe = outbox.subscribe((snapshot) => {
      dispatch({
        type: 'outbox',
        messages: snapshot.items.map((item) => outbox.optimisticMessage(item)),
      })
      const failed = new Set(
        snapshot.items.filter((item) => item.status === 'failed').map((item) => item.clientId),
      )
      for (const item of snapshot.items) {
        if (item.status === 'failed' && !failedRef.current.has(item.clientId)) {
          analytics.track('message_sent', {
            ...messageEventContext(conversationRef.current, conversationId),
            type: item.input.type,
            isReply: item.input.replyToMessageId !== null,
            outcome: 'failed',
          })
        }
      }
      failedRef.current = failed
    })
    void outbox.load().then(() => {
      if (outboxRef.current !== outbox) return
      dispatch({
        type: 'outbox',
        messages: outbox.state().items.map((item) => outbox.optimisticMessage(item)),
      })
      if (onlineRef.current) void outbox.flush()
    })
    return () => {
      unsubscribe()
      if (outboxRef.current === outbox) outboxRef.current = null
    }
  }, [viewerId, runtime, earth, analytics, conversationId])

  useEffect(() => {
    if (online) void outboxRef.current?.flush()
  }, [online])

  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null)

  const send = useCallback(
    async (input: SendMessageInput) => {
      const outbox = outboxRef.current
      if (outbox === null) return
      const replyToMessageId = input.replyToMessageId ?? null
      await outbox.enqueue({
        conversationId,
        clientId: randomClientId(),
        type: input.type,
        text: input.text,
        payload: input.payload ?? {},
        replyToMessageId,
      })
      if (replyToMessageId !== null) {
        analytics.track('message_replied', {
          ...messageEventContext(conversationRef.current, conversationId),
          type: input.type,
        })
      }
    },
    [conversationId, analytics],
  )

  const retry = useCallback((clientId: string) => {
    void outboxRef.current?.retry(clientId)
  }, [])

  const discard = useCallback((clientId: string) => {
    dispatch({ type: 'discard', clientId })
    void outboxRef.current?.remove(clientId)
  }, [])

  // ------------------------------------------------------------------ reactions and deletes
  const toggleReaction = useCallback(
    (messageId: MessageId, reaction: string) => {
      const current = messagesRef.current.find((message) => message.id === messageId)
      if (current === undefined || current.status !== 'sent') return
      const mine = current.reactions.find((summary) => summary.reaction === reaction)
      const adding = mine?.reactedByMe !== true
      dispatch({ type: 'toggleReaction', messageId, reaction })
      if (adding) {
        analytics.track(
          'reaction_added',
          messageEventContext(conversationRef.current, conversationId),
        )
      }
      earth.conversations.messages.reactions.toggle({ messageId, reaction }).catch(() => {
        // Roll back: the server did not take it.
        dispatch({ type: 'toggleReaction', messageId, reaction })
      })
    },
    [earth, analytics, conversationId],
  )

  const deleteMessage = useCallback(
    async (messageId: MessageId) => {
      dispatch({ type: 'deleted', messageId, at: new Date().toISOString() })
      try {
        await earth.conversations.messages.delete(messageId)
      } catch {
        void subscriptionRef.current?.refresh()
      }
    },
    [earth],
  )

  // ------------------------------------------------------------------ read state
  const markedRef = useRef<MessageId | null>(null)
  const [visible, setVisible] = useState(isDocumentVisible)
  useEffect(() => {
    const onVisibility = () => setVisible(isDocumentVisible())
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const newestId = newestSentMessageId(state.messages)
  useEffect(() => {
    if (!enabled) return
    const target = messageIdToMarkRead({
      messages: messagesRef.current,
      markedId: markedRef.current,
      visible,
      online,
    })
    if (target === null) return
    const timer = setTimeout(() => {
      markedRef.current = target
      earth.conversations
        .markRead({ conversationId, lastReadMessageId: target })
        .then(() => {
          queryClient.setQueriesData(
            { queryKey: CONVERSATIONS_QUERY_KEY },
            (data: { pages?: Array<{ conversations: ConversationDetailDto[] }> } | undefined) =>
              data?.pages === undefined
                ? data
                : {
                    ...data,
                    pages: data.pages.map((page) => withUnreadCleared(page, conversationId)),
                  },
          )
        })
        .catch(() => {
          // Retried on the next new message or visibility change.
          markedRef.current = null
        })
    }, MARK_READ_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [enabled, earth, conversationId, newestId, visible, online, queryClient])

  const receipts = useQuery({
    queryKey: ['conversation', conversationId, 'receipts'],
    queryFn: () => earth.conversations.readReceipts(conversationId),
    enabled: enabled && loadStatus === 'ready',
    refetchInterval: READ_RECEIPTS_INTERVAL_MS,
    staleTime: 5_000,
  })
  const refetchReceipts = receipts.refetch
  useEffect(() => {
    receiptsRefetch.current = () => void refetchReceipts()
  }, [refetchReceipts])
  const seenBy = useMemo(
    () =>
      seenByFor(
        state.messages,
        mergeReadPointers(conversation?.members ?? [], receipts.data ?? []),
        viewerId,
      ),
    [state.messages, conversation, receipts.data, viewerId],
  )

  // ------------------------------------------------------------------ presence
  const [peers, setPeers] = useState<readonly PresencePeer[]>([])
  const presenceRef = useRef<PresenceHandle | null>(null)
  const lastTypingAt = useRef(0)

  useEffect(() => {
    if (!enabled || runtime === null || viewerId === null) return
    const handle = joinPresence({
      supabase: runtime.supabase,
      kind: 'conversation',
      id: conversationId,
      key: viewerId,
      onPeers: setPeers,
    })
    presenceRef.current = handle
    void handle.trackActive()
    const factories = createRealtimeFactories(earth)
    const pinger = createPresencePinger({
      presencePing: factories.presencePing,
      foregrounded: isDocumentVisible,
      initialContext: { conversationId, roomId: null },
    })
    pinger.start()
    const onVisibility = () => {
      if (isDocumentVisible()) void pinger.pingNow()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      pinger.stop()
      presenceRef.current = null
      void handle.leave()
    }
  }, [enabled, runtime, earth, conversationId, viewerId])

  const noteTyping = useCallback(() => {
    const now = Date.now()
    if (now - lastTypingAt.current < TYPING_ANNOUNCE_MS) return
    lastTypingAt.current = now
    void presenceRef.current?.trackTyping(true)
  }, [])

  const presence = useMemo<ConversationPresence>(() => {
    const nameOf = (key: string) => membersById.get(key as HumanId)?.displayName ?? null
    const typingNames = peers
      .filter((peer) => peer.typing && !peer.isSelf)
      .map((peer) => nameOf(peer.key))
      .filter((name): name is string => name !== null)
    const activeNames = peers
      .filter((peer) => peer.active && !peer.typing && !peer.isSelf)
      .map((peer) => nameOf(peer.key))
      .filter((name): name is string => name !== null)
    return { typingNames, activeNames }
  }, [peers, membersById])

  // ------------------------------------------------------------------ derived
  const rows = useMemo(
    () =>
      annotateMessages(state.messages, viewerId, new Date(), {
        today: chatCopy.today,
        yesterday: chatCopy.yesterday,
      }),
    [state.messages, viewerId],
  )

  const refreshConversation = useCallback(() => {
    void detail.refetch()
  }, [detail])

  return {
    conversationId,
    viewerId,
    conversation,
    conversationStatus:
      detail.isError && conversation === undefined
        ? 'error'
        : conversation === undefined
          ? 'loading'
          : 'ready',
    membersById,
    messages: state.messages,
    rows,
    loadStatus,
    hasOlder: state.nextCursor !== null,
    loadingOlder,
    connection: { online, mode, degraded: online && mode === 'polling' && pollFailing },
    presence,
    seenBy,
    replyTo,
    activeRoomId: conversation?.activeRoom?.roomId ?? null,
    reload: () => {
      setLoadStatus('loading')
      setReloadTick((tick) => tick + 1)
    },
    loadOlder,
    send,
    retry,
    discard,
    toggleReaction,
    deleteMessage,
    setReplyTo,
    noteTyping,
    refreshConversation,
  }
}

/** The sender's display name for a message, from the members map (or a quiet fallback). */
export function senderName(
  message: Pick<MessageDto, 'senderHumanId'>,
  membersById: ReadonlyMap<HumanId, ConversationMemberDto>,
  fallback: string,
): string {
  return membersById.get(message.senderHumanId)?.displayName ?? fallback
}
