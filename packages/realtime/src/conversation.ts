/**
 * Conversation subscription with polling fallback (ARCHITECTURE §8; spec §53–§54).
 *
 * Realtime path: `postgres_changes` INSERT/UPDATE on `messages` filtered by conversation and
 * INSERT/DELETE on `message_reactions`. Rows arrive snake_case straight from the WAL, so they are
 * mapped to `MessageDto` here (validated with the DTO schema); a row that cannot be mapped
 * triggers a catch-up fetch instead of being dropped.
 *
 * Fallback path: if the channel has not joined within `joinTimeoutMs` (5 s) or reports
 * `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED`, the subscription polls `messages_since(conversation_id,
 * after_id)` every `pollIntervalMs` (2 s) through the injected `fetchSince`, emits one
 * `realtime_fallback` diagnostic per degradation, keeps re-subscribing with exponential backoff and
 * emits `realtime_recovered` when the channel joins again (with a final catch-up so the gap is
 * closed). Messages are deduplicated by id and delivered in the order the server returns them.
 *
 * `message_reactions` carries a denormalized `conversation_id` (set by trigger from the message,
 * migration 0250; DB_API §2), so its binding uses the same `conversation_id=eq.<id>` filter as
 * `messages`, and the table has `replica identity full` (0280) so a filtered DELETE still carries
 * the column. Every `ReactionChangeEvent` names its `conversationId` — taken from the row and
 * checked against the subscription; a row naming another conversation is dropped.
 */
import {
  type ConversationId,
  ConversationIdSchema,
  HumanIdSchema,
  type HumanId,
  type MessageDto,
  MessageDtoSchema,
  type MessageId,
  MessageIdSchema,
  REALTIME_JOIN_TIMEOUT_MS,
  REALTIME_POLL_INTERVAL_MS,
} from '@earth/domain'

import {
  type ChannelSupervisor,
  type PostgresChangePayload,
  REALTIME_SCHEMA,
  REALTIME_TABLES,
  type RealtimeClientLike,
  type RealtimeMode,
  type RealtimeSubscriptionStatus,
  conversationChangesTopic,
  createChannelSupervisor,
  postgresEqFilter,
} from './channel'
import { type CancelTimer, type RealtimeClock, errorReason, systemClock } from './clock'
import { type RealtimeDiagnostics, emitDiagnostic, noopDiagnostics } from './diagnostics'

export const MESSAGE_CHANGES = ['inserted', 'updated'] as const
export type MessageChange = (typeof MESSAGE_CHANGES)[number]

export const REACTION_CHANGES = ['added', 'removed'] as const
export type ReactionChange = (typeof REACTION_CHANGES)[number]

/** One `message_reactions` row appearing or disappearing; UIs adjust the message's summary. */
export interface ReactionChangeEvent {
  readonly messageId: MessageId
  readonly humanId: HumanId
  readonly reaction: string
  readonly change: ReactionChange
  /**
   * The conversation the reacted message belongs to. Always set on events delivered by
   * `subscribeConversation` (from the row's `conversation_id`, else the subscription's); optional
   * only so consumers that build events by hand (reducers, tests) need not supply it.
   */
  readonly conversationId?: ConversationId
}

export interface SubscribeConversationOptions {
  readonly supabase: RealtimeClientLike
  readonly conversationId: ConversationId
  /** `messages_since(conversation_id, after_id)` (DB_API §2): ascending, after the given id. */
  readonly fetchSince: (afterId: MessageId | null) => Promise<readonly MessageDto[]>
  /**
   * `inserted` messages carry the row's fields with `reactions: []`; `updated` messages (edits,
   * deletes) likewise carry no reactions — keep the ones already held for that id.
   */
  readonly onMessage: (message: MessageDto, change: MessageChange) => void
  readonly onReaction?: (event: ReactionChangeEvent) => void
  readonly onStatus?: (status: RealtimeSubscriptionStatus) => void
  readonly diagnostics?: RealtimeDiagnostics
  readonly clock?: RealtimeClock
  readonly pollIntervalMs?: number
  readonly joinTimeoutMs?: number
  /** Newest message id the caller already holds; polling and catch-ups start after it. */
  readonly lastSeenMessageId?: MessageId | null
}

export interface ConversationSubscription {
  /** Idempotent; stops the channel, timers and any in-flight polling delivery. */
  unsubscribe(): void
  mode(): RealtimeMode
  status(): RealtimeSubscriptionStatus
  lastSeenMessageId(): MessageId | null
  /** Manual catch-up (`fetchSince(lastSeen)`), for example when the app returns to the foreground. */
  refresh(): Promise<void>
}

// ---------------------------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------------------------

const ISO_DATE_TIME_NO_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/
const ISO_DATE_TIME_SHORT_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?[+-]\d{2}$/

/**
 * Timestamps in change payloads can be `2026-09-03 12:00:00.123+00` (Postgres text form) rather
 * than the `to_jsonb` form the DTO schema expects; normalise to ISO 8601 with a full offset.
 */
export function normalizeIsoTimestamp(value: unknown): unknown {
  if (typeof value !== 'string') return value
  let text = value.trim()
  if (text.length > 10 && text[10] === ' ') text = `${text.slice(0, 10)}T${text.slice(11)}`
  if (ISO_DATE_TIME_NO_OFFSET.test(text)) return `${text}Z`
  if (ISO_DATE_TIME_SHORT_OFFSET.test(text)) return `${text}:00`
  return text
}

/** Maps a `messages` row (snake_case, no reactions) to a `MessageDto`; `null` when malformed. */
export function messageRowToDto(row: Record<string, unknown>): MessageDto | null {
  const candidate = {
    id: row['id'],
    conversationId: row['conversation_id'],
    senderHumanId: row['sender_human_id'],
    type: row['type'],
    text: row['text'] ?? null,
    payload: row['payload'] ?? {},
    replyToMessageId: row['reply_to_message_id'] ?? null,
    createdAt: normalizeIsoTimestamp(row['created_at']),
    editedAt: normalizeIsoTimestamp(row['edited_at'] ?? null),
    deletedAt: normalizeIsoTimestamp(row['deleted_at'] ?? null),
    clientId: row['client_id'] ?? null,
    reactions: [],
  }
  const parsed = MessageDtoSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

/**
 * Maps a `message_reactions` row to a change event; `null` when malformed or, when
 * `conversationId` is given and the row names one, from another conversation. The event's
 * `conversationId` is the row's when present, else the expected one.
 */
export function reactionRowToChange(
  row: Record<string, unknown>,
  change: ReactionChange,
  conversationId?: ConversationId,
): ReactionChangeEvent | null {
  const messageId = MessageIdSchema.safeParse(row['message_id'])
  const humanId = HumanIdSchema.safeParse(row['human_id'])
  const reaction = row['reaction']
  if (!messageId.success || !humanId.success) return null
  if (typeof reaction !== 'string' || reaction.length === 0) return null
  let eventConversationId: ConversationId | undefined = conversationId
  const rowConversationId = row['conversation_id']
  if (rowConversationId !== undefined && rowConversationId !== null) {
    const parsed = ConversationIdSchema.safeParse(rowConversationId)
    if (!parsed.success) return null
    if (conversationId !== undefined && parsed.data !== conversationId) return null
    eventConversationId = parsed.data
  }
  return {
    messageId: messageId.data,
    humanId: humanId.data,
    reaction,
    change,
    ...(eventConversationId === undefined ? {} : { conversationId: eventConversationId }),
  }
}

// ---------------------------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------------------------

export function subscribeConversation(
  options: SubscribeConversationOptions,
): ConversationSubscription {
  const clock = options.clock ?? systemClock
  const diagnostics = options.diagnostics ?? noopDiagnostics
  const pollIntervalMs = options.pollIntervalMs ?? REALTIME_POLL_INTERVAL_MS
  const joinTimeoutMs = options.joinTimeoutMs ?? REALTIME_JOIN_TIMEOUT_MS
  const { conversationId } = options

  const seen = new Set<string>()
  let lastSeen: MessageId | null = options.lastSeenMessageId ?? null
  let stopped = false
  let fetching: Promise<void> | null = null
  let fetchAgain = false
  let pollFailures = 0
  let cancelPoll: CancelTimer | null = null

  const deliverMessage = (message: MessageDto, change: MessageChange): void => {
    if (stopped || message.conversationId !== conversationId) return
    if (change === 'inserted') {
      if (seen.has(message.id)) return
      seen.add(message.id)
      lastSeen = message.id
    }
    options.onMessage(message, change)
  }

  const fetchOnce = async (): Promise<void> => {
    try {
      const messages = await options.fetchSince(lastSeen)
      pollFailures = 0
      if (stopped) return
      for (const message of messages) deliverMessage(message, 'inserted')
    } catch (error) {
      pollFailures += 1
      if (pollFailures === 1) {
        emitDiagnostic(diagnostics, {
          kind: 'realtime_poll_failed',
          channel: 'conversation',
          conversationId,
          attempt: pollFailures,
          reason: errorReason(error),
        })
      }
    }
  }

  /** Coalesces concurrent catch-ups: a request during a fetch runs one more fetch afterwards. */
  const catchUp = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    if (fetching !== null) {
      fetchAgain = true
      return fetching
    }
    fetching = (async () => {
      do {
        fetchAgain = false
        await fetchOnce()
      } while (fetchAgain && !stopped)
    })().finally(() => {
      fetching = null
    })
    return fetching
  }

  const stopPolling = (): void => {
    cancelPoll?.()
    cancelPoll = null
  }

  const schedulePoll = (): void => {
    if (stopped || supervisor.mode() !== 'polling') return
    cancelPoll?.()
    cancelPoll = clock.schedule(() => {
      cancelPoll = null
      void catchUp().finally(schedulePoll)
    }, pollIntervalMs)
  }

  const startPolling = (): void => {
    void catchUp().finally(schedulePoll)
  }

  const handleMessagePayload = (payload: PostgresChangePayload, change: MessageChange): void => {
    const message = messageRowToDto(payload.new)
    if (message === null) {
      // The row could not be trusted (missing columns, unexpected shape): fetch canonically.
      void catchUp()
      return
    }
    deliverMessage(message, change)
  }

  const handleReactionPayload = (payload: PostgresChangePayload): void => {
    if (options.onReaction === undefined || stopped) return
    const event =
      payload.eventType === 'INSERT'
        ? reactionRowToChange(payload.new, 'added', conversationId)
        : payload.eventType === 'DELETE'
          ? reactionRowToChange(payload.old, 'removed', conversationId)
          : null
    if (event !== null) options.onReaction(event)
  }

  const supervisor: ChannelSupervisor = createChannelSupervisor({
    supabase: options.supabase,
    topic: conversationChangesTopic(conversationId),
    clock,
    joinTimeoutMs,
    bind(channel) {
      const filter = postgresEqFilter('conversation_id', conversationId)
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: REALTIME_SCHEMA, table: REALTIME_TABLES.messages, filter },
        (payload) => handleMessagePayload(payload, 'inserted'),
      )
      channel.on(
        'postgres_changes',
        { event: 'UPDATE', schema: REALTIME_SCHEMA, table: REALTIME_TABLES.messages, filter },
        (payload) => handleMessagePayload(payload, 'updated'),
      )
      channel.on(
        'postgres_changes',
        { event: '*', schema: REALTIME_SCHEMA, table: REALTIME_TABLES.messageReactions, filter },
        handleReactionPayload,
      )
    },
    onSubscribed(_channel, recovered) {
      if (recovered) {
        stopPolling()
        emitDiagnostic(diagnostics, {
          kind: 'realtime_recovered',
          channel: 'conversation',
          conversationId,
        })
        // Close the gap between the last poll and the join.
        void catchUp()
      } else if (lastSeen !== null) {
        // Messages sent between the caller's page load and the join are not replayed.
        void catchUp()
      }
    },
    onFailure(reason, failures, degraded, error) {
      if (degraded) {
        emitDiagnostic(diagnostics, {
          kind: 'realtime_fallback',
          channel: 'conversation',
          conversationId,
          attempt: failures,
          reason: error === undefined ? reason : `${reason}: ${errorReason(error)}`,
          code: reason,
        })
        startPolling()
      }
    },
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
  })

  supervisor.start()

  return {
    unsubscribe() {
      if (stopped) return
      stopped = true
      stopPolling()
      supervisor.stop()
    },
    mode: () => supervisor.mode(),
    status: () => supervisor.status(),
    lastSeenMessageId: () => lastSeen,
    refresh: () => catchUp(),
  }
}
