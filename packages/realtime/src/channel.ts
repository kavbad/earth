/**
 * Minimal structural interface for supabase-js Realtime (ARCHITECTURE §8) plus the channel
 * supervisor shared by the conversation, room and presence subscriptions.
 *
 * Only the slice of `SupabaseClient` / `RealtimeChannel` this package touches is described, so
 * production passes the real client and tests pass a fake (`./testing/fake-supabase`). The shapes
 * follow `@supabase/realtime-js` 2.x (`channel(topic).on('postgres_changes', filter, cb)
 * .subscribe(statusCb)`, `removeChannel(channel)`, presence `track` / `presenceState`).
 *
 * The supervisor owns one channel at a time: it subscribes, enforces the join timeout, reports
 * degradation (the caller starts polling), re-subscribes with exponential backoff after every
 * failure and reports recovery when a later join succeeds. It never polls itself.
 */
import {
  type BackoffPolicy,
  CHANNEL_BACKOFF,
  type CancelTimer,
  type RealtimeClock,
  exponentialBackoffMs,
} from './clock'

// ---------------------------------------------------------------------------------------------
// supabase-js structural types
// ---------------------------------------------------------------------------------------------

/** Every table in the `supabase_realtime` publication this package listens to (ARCHITECTURE §5). */
export const REALTIME_SCHEMA = 'public' as const
export const REALTIME_TABLES = {
  messages: 'messages',
  messageReactions: 'message_reactions',
  rooms: 'rooms',
  roomParticipants: 'room_participants',
} as const
export type RealtimeTable = (typeof REALTIME_TABLES)[keyof typeof REALTIME_TABLES]

/** `subscribe()` callback statuses (`REALTIME_SUBSCRIBE_STATES` in realtime-js). */
export const REALTIME_SUBSCRIBE_STATUSES = [
  'SUBSCRIBED',
  'TIMED_OUT',
  'CLOSED',
  'CHANNEL_ERROR',
] as const
export type RealtimeSubscribeStatus = (typeof REALTIME_SUBSCRIBE_STATUSES)[number]

const SUBSCRIBE_STATUS_SET: ReadonlySet<string> = new Set<string>(REALTIME_SUBSCRIBE_STATUSES)

export function isRealtimeSubscribeStatus(value: unknown): value is RealtimeSubscribeStatus {
  return typeof value === 'string' && SUBSCRIBE_STATUS_SET.has(value)
}

export const POSTGRES_CHANGE_EVENTS = ['INSERT', 'UPDATE', 'DELETE', '*'] as const
export type PostgresChangeEvent = (typeof POSTGRES_CHANGE_EVENTS)[number]
export type PostgresChangeType = Exclude<PostgresChangeEvent, '*'>

export interface PostgresChangesFilter {
  readonly event: PostgresChangeEvent
  readonly schema: string
  readonly table: string
  /** `column=eq.value` (see `postgresEqFilter`). */
  readonly filter?: string
}

/** Row payload delivered by `postgres_changes`; `new` is `{}` for deletes, `old` for inserts. */
export interface PostgresChangePayload {
  readonly eventType: PostgresChangeType
  readonly schema: string
  readonly table: string
  readonly new: Record<string, unknown>
  readonly old: Record<string, unknown>
}
export type PostgresChangeCallback = (payload: PostgresChangePayload) => void

export const PRESENCE_LISTEN_EVENTS = { sync: 'sync' } as const

/** One tracked presence entry; `presence_ref` is added by the server. */
export interface PresenceMeta {
  readonly presence_ref: string
  readonly [key: string]: unknown
}
/** `presenceState()`: presence key → entries (one per connected client with that key). */
export type PresenceStateLike = Readonly<Record<string, readonly PresenceMeta[]>>

export interface RealtimeChannelLike {
  on(
    type: 'postgres_changes',
    filter: PostgresChangesFilter,
    callback: PostgresChangeCallback,
  ): unknown
  on(
    type: 'presence',
    filter: { readonly event: typeof PRESENCE_LISTEN_EVENTS.sync },
    callback: () => void,
  ): unknown
  subscribe(
    callback?: (status: RealtimeSubscribeStatus, error?: Error) => void,
    timeoutMs?: number,
  ): unknown
  track(payload: Record<string, unknown>): Promise<unknown>
  untrack(): Promise<unknown>
  presenceState(): PresenceStateLike
}

export interface RealtimeChannelOptionsLike {
  readonly config: {
    readonly presence?: { readonly key?: string; readonly enabled?: boolean }
    readonly private?: boolean
  }
}

/** The slice of `SupabaseClient` used here; `createClient(...)` satisfies it. */
export interface RealtimeClientLike {
  channel(topic: string, options?: RealtimeChannelOptionsLike): RealtimeChannelLike
  removeChannel(channel: RealtimeChannelLike): Promise<unknown>
}

/** `column=eq.value` filter for `postgres_changes`. */
export function postgresEqFilter(column: string, value: string): string {
  return `${column}=eq.${value}`
}

/** Topic of the `postgres_changes` channel for a conversation (presence uses `conversation:<id>`). */
export function conversationChangesTopic(conversationId: string): string {
  return `conversation:${conversationId}:changes`
}

/** Topic of the `postgres_changes` channel for a room (presence uses `room:<id>`). */
export function roomChangesTopic(roomId: string): string {
  return `room:${roomId}:changes`
}

// ---------------------------------------------------------------------------------------------
// Channel supervisor
// ---------------------------------------------------------------------------------------------

/** Delivery mode of a supervised subscription (ARCHITECTURE §8: fallback is a product feature). */
export const REALTIME_MODES = ['realtime', 'polling'] as const
export type RealtimeMode = (typeof REALTIME_MODES)[number]

/** Why a channel was considered failed; `join_timeout` is this package's own timer. */
export const CHANNEL_FAILURE_REASONS = [
  'join_timeout',
  'CHANNEL_ERROR',
  'TIMED_OUT',
  'CLOSED',
] as const
export type ChannelFailureReason = (typeof CHANNEL_FAILURE_REASONS)[number]

export interface RealtimeSubscriptionStatus {
  readonly mode: RealtimeMode
  /** The current channel has joined. */
  readonly subscribed: boolean
  /** Consecutive failures since the last successful join (drives the backoff). */
  readonly failures: number
  readonly lastFailure: ChannelFailureReason | null
}

export interface ChannelSupervisorOptions {
  readonly supabase: RealtimeClientLike
  readonly topic: string
  readonly channelOptions?: RealtimeChannelOptionsLike
  /** Attaches listeners to every (re)created channel before it subscribes. */
  readonly bind: (channel: RealtimeChannelLike) => void
  readonly clock: RealtimeClock
  readonly joinTimeoutMs: number
  readonly backoff?: BackoffPolicy
  /** The channel joined; `recovered` is true when it had previously degraded. */
  readonly onSubscribed?: (channel: RealtimeChannelLike, recovered: boolean) => void
  /** The channel failed; `degraded` is true on the transition into polling mode. */
  readonly onFailure?: (
    reason: ChannelFailureReason,
    failures: number,
    degraded: boolean,
    error?: Error,
  ) => void
  readonly onStatus?: (status: RealtimeSubscriptionStatus) => void
}

export interface ChannelSupervisor {
  start(): void
  /** Idempotent; cancels timers and removes the channel. */
  stop(): void
  mode(): RealtimeMode
  status(): RealtimeSubscriptionStatus
  channel(): RealtimeChannelLike | null
}

export function createChannelSupervisor(options: ChannelSupervisorOptions): ChannelSupervisor {
  const backoff = options.backoff ?? CHANNEL_BACKOFF
  let current: RealtimeChannelLike | null = null
  let started = false
  let stopped = false
  let mode: RealtimeMode = 'realtime'
  let subscribed = false
  let failures = 0
  let lastFailure: ChannelFailureReason | null = null
  let cancelJoinTimer: CancelTimer | null = null
  let cancelRetryTimer: CancelTimer | null = null

  const status = (): RealtimeSubscriptionStatus => ({ mode, subscribed, failures, lastFailure })
  const publishStatus = (): void => options.onStatus?.(status())

  const clearTimers = (): void => {
    cancelJoinTimer?.()
    cancelJoinTimer = null
    cancelRetryTimer?.()
    cancelRetryTimer = null
  }

  const removeCurrent = (): void => {
    if (current === null) return
    const channel = current
    current = null
    subscribed = false
    void options.supabase.removeChannel(channel).catch(() => undefined)
  }

  const scheduleResubscribe = (): void => {
    if (stopped) return
    cancelRetryTimer?.()
    cancelRetryTimer = options.clock.schedule(
      () => {
        cancelRetryTimer = null
        subscribe()
      },
      exponentialBackoffMs(failures, backoff),
    )
  }

  const fail = (
    channel: RealtimeChannelLike,
    reason: ChannelFailureReason,
    error?: Error,
  ): void => {
    if (stopped || channel !== current) return
    cancelJoinTimer?.()
    cancelJoinTimer = null
    failures += 1
    lastFailure = reason
    const degraded = mode === 'realtime'
    mode = 'polling'
    removeCurrent()
    publishStatus()
    options.onFailure?.(reason, failures, degraded, error)
    scheduleResubscribe()
  }

  const joined = (channel: RealtimeChannelLike): void => {
    if (stopped || channel !== current) return
    cancelJoinTimer?.()
    cancelJoinTimer = null
    const recovered = mode === 'polling'
    mode = 'realtime'
    subscribed = true
    failures = 0
    lastFailure = null
    publishStatus()
    options.onSubscribed?.(channel, recovered)
  }

  const subscribe = (): void => {
    if (stopped) return
    const channel = options.supabase.channel(options.topic, options.channelOptions)
    current = channel
    subscribed = false
    options.bind(channel)
    cancelJoinTimer = options.clock.schedule(
      () => fail(channel, 'join_timeout'),
      options.joinTimeoutMs,
    )
    channel.subscribe((subscribeStatus, error) => {
      if (subscribeStatus === 'SUBSCRIBED') {
        joined(channel)
        return
      }
      if (isRealtimeSubscribeStatus(subscribeStatus)) {
        fail(channel, subscribeStatus, error)
      }
    })
    publishStatus()
  }

  return {
    start() {
      if (started || stopped) return
      started = true
      subscribe()
    },
    stop() {
      if (stopped) return
      stopped = true
      clearTimers()
      removeCurrent()
    },
    mode: () => mode,
    status,
    channel: () => current,
  }
}
