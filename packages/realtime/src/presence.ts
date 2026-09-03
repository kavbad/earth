/**
 * Supabase Realtime presence for `conversation:<id>` / `room:<id>` (ARCHITECTURE §8) and the
 * `presence_ping` scheduler that keeps `human_presence` fresh while the app is foregrounded.
 *
 * Presence is ephemeral typing / active state between clients on the same channel; it never
 * touches the database. The ping is what the push dispatcher reads (ARCHITECTURE §11: skip
 * recipients active in the same conversation within 30 s), so it runs every
 * `PRESENCE_PING_INTERVAL_SECONDS` while `foregrounded()` is true and immediately when the active
 * conversation or room changes.
 */
import {
  type ConversationId,
  PRESENCE_PING_INTERVAL_SECONDS,
  REALTIME_JOIN_TIMEOUT_MS,
  type RoomId,
} from '@earth/domain'

import {
  type ChannelSupervisor,
  PRESENCE_LISTEN_EVENTS,
  type PresenceStateLike,
  type RealtimeChannelLike,
  type RealtimeClientLike,
  type RealtimeSubscriptionStatus,
  createChannelSupervisor,
} from './channel'
import {
  type CancelTimer,
  type RealtimeClock,
  errorReason,
  scheduleInterval,
  systemClock,
} from './clock'
import { type RealtimeDiagnostics, emitDiagnostic, noopDiagnostics } from './diagnostics'

export const PRESENCE_CHANNEL_KINDS = ['conversation', 'room'] as const
export type PresenceChannelKind = (typeof PRESENCE_CHANNEL_KINDS)[number]

/** `conversation:<id>` / `room:<id>` (ARCHITECTURE §8). */
export function presenceTopic(kind: PresenceChannelKind, id: string): string {
  return `${kind}:${id}`
}

/** A typing indicator that is not refreshed expires after this long (locally and for peers). */
export const TYPING_TTL_MS = 5_000

/** Presence join timeout; presence has no polling fallback, it simply retries. */
export const PRESENCE_JOIN_TIMEOUT_MS: number = REALTIME_JOIN_TIMEOUT_MS

/** What a client says about itself. */
export type PresenceFields = {
  readonly typing: boolean
  readonly active: boolean
}

/** Payload tracked on the channel. Keys are the wire contract between clients. */
export type PresencePayload = PresenceFields & {
  /** ISO 8601; peers ignore typing older than `TYPING_TTL_MS`. */
  readonly updatedAt: string
}

export interface PresencePeer {
  /** The presence key: `humans.id` or `guest_sessions.id` of that client. */
  readonly key: string
  readonly typing: boolean
  readonly active: boolean
  readonly updatedAt: string | null
  readonly isSelf: boolean
}

export interface JoinPresenceOptions {
  readonly supabase: RealtimeClientLike
  readonly kind: PresenceChannelKind
  readonly id: string
  /** Presence key of this client (the viewer's Human id, or guest session id). */
  readonly key: string
  readonly onPeers?: (peers: readonly PresencePeer[]) => void
  readonly onStatus?: (status: RealtimeSubscriptionStatus) => void
  readonly diagnostics?: RealtimeDiagnostics
  readonly clock?: RealtimeClock
  readonly typingTtlMs?: number
  readonly joinTimeoutMs?: number
}

export interface PresenceHandle {
  /** Marks this client as typing (auto-clears after the TTL) or not typing. */
  trackTyping(typing?: boolean): Promise<void>
  /** Marks this client as active and not typing. */
  trackActive(): Promise<void>
  peers(): readonly PresencePeer[]
  /** Peers (never self) whose typing indicator is fresh. */
  typingPeers(): readonly PresencePeer[]
  subscribed(): boolean
  /** Untracks and removes the channel. Idempotent. */
  leave(): Promise<void>
}

/** Reads the newest entry per key out of a `presenceState()` snapshot. */
export function parsePresenceState(
  state: PresenceStateLike,
  selfKey: string,
  nowMs: number,
  typingTtlMs: number = TYPING_TTL_MS,
): PresencePeer[] {
  const peers: PresencePeer[] = []
  for (const [key, entries] of Object.entries(state)) {
    let typing = false
    let active = false
    let updatedAt: string | null = null
    for (const entry of entries) {
      const entryUpdatedAt = typeof entry['updatedAt'] === 'string' ? entry['updatedAt'] : null
      const fresh = entryUpdatedAt === null || nowMs - Date.parse(entryUpdatedAt) <= typingTtlMs
      if (entry['active'] === true) active = true
      if (entry['typing'] === true && fresh) typing = true
      if (
        entryUpdatedAt !== null &&
        (updatedAt === null || Date.parse(entryUpdatedAt) > Date.parse(updatedAt))
      ) {
        updatedAt = entryUpdatedAt
      }
    }
    peers.push({ key, typing, active, updatedAt, isSelf: key === selfKey })
  }
  return peers
}

export function joinPresence(options: JoinPresenceOptions): PresenceHandle {
  const clock = options.clock ?? systemClock
  const diagnostics = options.diagnostics ?? noopDiagnostics
  const typingTtlMs = options.typingTtlMs ?? TYPING_TTL_MS
  const joinTimeoutMs = options.joinTimeoutMs ?? PRESENCE_JOIN_TIMEOUT_MS

  let left = false
  let joinedChannel: RealtimeChannelLike | null = null
  let desired: PresencePayload | null = null
  let cancelTypingExpiry: CancelTimer | null = null
  let peers: readonly PresencePeer[] = []

  const publishPeers = (channel: RealtimeChannelLike): void => {
    if (left) return
    peers = parsePresenceState(channel.presenceState(), options.key, clock.now(), typingTtlMs)
    options.onPeers?.(peers)
  }

  const push = async (): Promise<void> => {
    if (left || desired === null || joinedChannel === null) return
    try {
      await joinedChannel.track(desired)
    } catch {
      // Presence is best effort; the next track or re-join carries the state.
    }
  }

  const track = (payload: PresenceFields): Promise<void> => {
    desired = { ...payload, updatedAt: new Date(clock.now()).toISOString() }
    return push()
  }

  const supervisor: ChannelSupervisor = createChannelSupervisor({
    supabase: options.supabase,
    topic: presenceTopic(options.kind, options.id),
    channelOptions: { config: { presence: { key: options.key, enabled: true } } },
    clock,
    joinTimeoutMs,
    bind(channel) {
      channel.on('presence', { event: PRESENCE_LISTEN_EVENTS.sync }, () => publishPeers(channel))
    },
    onSubscribed(channel, recovered) {
      joinedChannel = channel
      if (recovered) {
        emitDiagnostic(diagnostics, { kind: 'realtime_recovered', channel: 'presence' })
      }
      void push()
    },
    onFailure(reason, failures, degraded, error) {
      joinedChannel = null
      if (degraded) {
        emitDiagnostic(diagnostics, {
          kind: 'realtime_fallback',
          channel: 'presence',
          attempt: failures,
          reason: error === undefined ? reason : `${reason}: ${errorReason(error)}`,
          code: reason,
        })
      }
    },
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
  })

  supervisor.start()

  return {
    trackTyping(typing = true) {
      cancelTypingExpiry?.()
      cancelTypingExpiry = null
      if (typing) {
        cancelTypingExpiry = clock.schedule(() => {
          cancelTypingExpiry = null
          void track({ typing: false, active: true })
        }, typingTtlMs)
      }
      return track({ typing, active: true })
    },
    trackActive() {
      cancelTypingExpiry?.()
      cancelTypingExpiry = null
      return track({ typing: false, active: true })
    },
    peers: () => peers,
    typingPeers: () => peers.filter((peer) => peer.typing && !peer.isSelf),
    subscribed: () => supervisor.status().subscribed,
    async leave() {
      if (left) return
      left = true
      cancelTypingExpiry?.()
      cancelTypingExpiry = null
      const channel = joinedChannel
      joinedChannel = null
      if (channel !== null) {
        try {
          await channel.untrack()
        } catch {
          // The channel is removed next; the server drops the presence with it.
        }
      }
      supervisor.stop()
    },
  }
}

// ---------------------------------------------------------------------------------------------
// presence_ping scheduler
// ---------------------------------------------------------------------------------------------

export const PRESENCE_PING_INTERVAL_MS = PRESENCE_PING_INTERVAL_SECONDS * 1_000

/** What the viewer is looking at; both `null` on screens without a conversation or room. */
export interface PresenceContext {
  readonly conversationId: ConversationId | null
  readonly roomId: RoomId | null
}

export const EMPTY_PRESENCE_CONTEXT: PresenceContext = { conversationId: null, roomId: null }

export interface PresencePingerOptions {
  /** `presence_ping(conversation_id, room_id)` RPC (DB_API §6) through `@earth/api`. */
  readonly presencePing: (
    conversationId: ConversationId | null,
    roomId: RoomId | null,
  ) => Promise<unknown> | unknown
  /** True while the app is in the foreground; ticks are skipped otherwise. */
  readonly foregrounded: () => boolean
  readonly clock?: RealtimeClock
  readonly intervalMs?: number
  readonly onError?: (error: unknown) => void
  readonly initialContext?: PresenceContext
}

export interface PresencePinger {
  /** Pings now (when foregrounded) and every interval after. Idempotent. */
  start(): void
  stop(): void
  running(): boolean
  context(): PresenceContext
  /** Changes what is pinged; pings immediately when running and foregrounded. */
  setContext(context: PresenceContext): void
  /** Forces a ping regardless of the schedule (call on foreground transitions). */
  pingNow(): Promise<void>
}

export function createPresencePinger(options: PresencePingerOptions): PresencePinger {
  const clock = options.clock ?? systemClock
  const intervalMs = options.intervalMs ?? PRESENCE_PING_INTERVAL_MS
  let context: PresenceContext = options.initialContext ?? EMPTY_PRESENCE_CONTEXT
  let cancelInterval: CancelTimer | null = null

  const ping = async (): Promise<void> => {
    try {
      await options.presencePing(context.conversationId, context.roomId)
    } catch (error) {
      options.onError?.(error)
    }
  }

  const pingIfForegrounded = (): Promise<void> =>
    options.foregrounded() ? ping() : Promise.resolve()

  return {
    start() {
      if (cancelInterval !== null) return
      cancelInterval = scheduleInterval(clock, () => void pingIfForegrounded(), intervalMs)
      void pingIfForegrounded()
    },
    stop() {
      cancelInterval?.()
      cancelInterval = null
    },
    running: () => cancelInterval !== null,
    context: () => context,
    setContext(next) {
      const changed =
        next.conversationId !== context.conversationId || next.roomId !== context.roomId
      context = next
      if (changed && cancelInterval !== null) void pingIfForegrounded()
    },
    pingNow: ping,
  }
}
