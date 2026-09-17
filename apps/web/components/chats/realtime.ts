/**
 * Realtime wiring the chat screens share (ARCHITECTURE §8): the diagnostics emitter that posts
 * `realtime_fallback` / `message_send_failed` to `/api/diagnostics/rtc` through the client, and the
 * chats-list subscription — `postgres_changes` on `messages` (inserts) and `conversations`
 * (updates) with no row filter, which RLS narrows to the viewer's own conversations. The list
 * refetches on every event; when the channel degrades the list polls instead.
 */
import type { EarthClient } from '@earth/api'
import {
  type ChannelSupervisor,
  REALTIME_SCHEMA,
  REALTIME_TABLES,
  type RealtimeClientLike,
  type RealtimeClock,
  type RealtimeDiagnostics,
  type RealtimeSubscriptionStatus,
  createChannelSupervisor,
  emitDiagnostic,
  systemClock,
} from '@earth/realtime'
import { REALTIME_JOIN_TIMEOUT_MS } from '@earth/domain'

/** Forwards realtime diagnostics to the server tier; never throws, never awaited by callers. */
export function createChatDiagnostics(
  earth: Pick<EarthClient, 'diagnostics'>,
): RealtimeDiagnostics {
  return {
    emit(event) {
      return earth.diagnostics
        .rtc({ v: 1, ts: new Date().toISOString(), event: { ...event } })
        .catch(() => undefined)
    },
  }
}

export const CONVERSATIONS_FEED_TOPIC = 'conversations:changes' as const

export interface SubscribeConversationsFeedOptions {
  readonly supabase: RealtimeClientLike
  /** Something changed in one of the viewer's conversations: refetch the list. */
  readonly onChange: () => void
  readonly onStatus?: (status: RealtimeSubscriptionStatus) => void
  readonly diagnostics?: RealtimeDiagnostics
  readonly clock?: RealtimeClock
  readonly joinTimeoutMs?: number
}

export interface ConversationsFeedSubscription {
  unsubscribe(): void
  status(): RealtimeSubscriptionStatus
}

export function subscribeConversationsFeed(
  options: SubscribeConversationsFeedOptions,
): ConversationsFeedSubscription {
  const clock = options.clock ?? systemClock
  let stopped = false
  const supervisor: ChannelSupervisor = createChannelSupervisor({
    supabase: options.supabase,
    topic: CONVERSATIONS_FEED_TOPIC,
    clock,
    joinTimeoutMs: options.joinTimeoutMs ?? REALTIME_JOIN_TIMEOUT_MS,
    bind(channel) {
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: REALTIME_SCHEMA, table: REALTIME_TABLES.messages },
        () => {
          if (!stopped) options.onChange()
        },
      )
      channel.on(
        'postgres_changes',
        { event: 'UPDATE', schema: REALTIME_SCHEMA, table: 'conversations' },
        () => {
          if (!stopped) options.onChange()
        },
      )
    },
    onSubscribed(_channel, recovered) {
      // Close the gap between the last poll and the join.
      if (recovered && !stopped) options.onChange()
    },
    onFailure(reason, failures, degraded, error) {
      if (degraded && options.diagnostics !== undefined) {
        emitDiagnostic(options.diagnostics, {
          kind: 'realtime_fallback',
          channel: 'conversation',
          attempt: failures,
          reason: error === undefined ? reason : `${reason}: ${error.message}`,
          code: reason,
        })
      }
    },
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
  })
  supervisor.start()
  return {
    unsubscribe() {
      if (stopped) return
      stopped = true
      supervisor.stop()
    },
    status: () => supervisor.status(),
  }
}
