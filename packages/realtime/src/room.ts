/**
 * Room subscription with polling fallback (ARCHITECTURE §8; spec §57–§62, SCREEN 14).
 *
 * `postgres_changes` on `room_participants` (filtered by room) and `rooms` (filtered by id) are
 * used as triggers only: participant rows carry no display names or viewer relations, so every
 * change re-fetches the canonical `RoomDto` (`room_get`, DB_API §3) through the injected
 * `fetchState`, coalescing bursts into one in-flight fetch plus at most one follow-up. When the
 * channel fails to join or errors, the state is polled every `pollIntervalMs` (3 s) instead.
 *
 * Each new state is diffed against the previous one (`diffRoomState`) into deltas — participant
 * joined / left / media state / role / consent changes, room visibility / policy / status changes,
 * room ended — so UIs can animate participant tiles instead of re-rendering the grid.
 */
import {
  type MediaState,
  type ParticipantRole,
  REALTIME_JOIN_TIMEOUT_MS,
  type RoomDto,
  type RoomId,
  type RoomJoinPolicy,
  type RoomParticipantDto,
  type RoomStatus,
  type RoomVisibility,
} from '@earth/domain'

import {
  type ChannelSupervisor,
  REALTIME_SCHEMA,
  REALTIME_TABLES,
  type RealtimeClientLike,
  type RealtimeMode,
  type RealtimeSubscriptionStatus,
  createChannelSupervisor,
  postgresEqFilter,
  roomChangesTopic,
} from './channel'
import { type CancelTimer, type RealtimeClock, errorReason, systemClock } from './clock'
import { type RealtimeDiagnostics, emitDiagnostic, noopDiagnostics } from './diagnostics'

/** Room state polling cadence when Realtime is unavailable. */
export const ROOM_POLL_INTERVAL_MS = 3_000

const ROOM_STATUS_ENDED: RoomStatus = 'ended'
const PARTICIPANT_PRESENT_STATUS = 'active' as const

// ---------------------------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------------------------

export interface ParticipantJoinedDelta {
  readonly kind: 'participant_joined'
  readonly participant: RoomParticipantDto
}
export interface ParticipantLeftDelta {
  readonly kind: 'participant_left'
  /** The participant's latest known row (status `left` / `removed` when still returned). */
  readonly participant: RoomParticipantDto
}
export interface MediaStateChangedDelta {
  readonly kind: 'media_state_changed'
  readonly participant: RoomParticipantDto
  readonly previous: MediaState
}
export interface RoleChangedDelta {
  readonly kind: 'role_changed'
  readonly participant: RoomParticipantDto
  readonly previous: ParticipantRole
}
export interface ConsentChangedDelta {
  readonly kind: 'consent_changed'
  readonly participant: RoomParticipantDto
  readonly previous: RoomVisibility
}
export type RoomParticipantDelta =
  | ParticipantJoinedDelta
  | ParticipantLeftDelta
  | MediaStateChangedDelta
  | RoleChangedDelta
  | ConsentChangedDelta

/** Room-level fields whose changes are reported. */
export interface RoomFields {
  readonly visibility: RoomVisibility
  readonly joinPolicy: RoomJoinPolicy
  readonly pendingVisibility: RoomVisibility | null
  readonly status: RoomStatus
  readonly contextTitle: string | null
  readonly guestsDisabled: boolean
}
export interface RoomUpdatedDelta {
  readonly kind: 'room_updated'
  readonly changes: Partial<RoomFields>
  readonly previous: Partial<RoomFields>
}
export interface RoomEndedDelta {
  readonly kind: 'room_ended'
}
export type RoomStateDelta = RoomParticipantDelta | RoomUpdatedDelta | RoomEndedDelta
export type RoomStateDeltaKind = RoomStateDelta['kind']

const ROOM_FIELD_KEYS = [
  'visibility',
  'joinPolicy',
  'pendingVisibility',
  'status',
  'contextTitle',
  'guestsDisabled',
] as const satisfies readonly (keyof RoomFields)[]

const PARTICIPANT_DELTA_KINDS: ReadonlySet<RoomStateDeltaKind> = new Set<RoomStateDeltaKind>([
  'participant_joined',
  'participant_left',
  'media_state_changed',
  'role_changed',
  'consent_changed',
])

/** Participants shown as tiles: `active` rows only (invited / waiting are not in the room yet). */
export function isPresentParticipant(participant: RoomParticipantDto): boolean {
  return participant.status === PARTICIPANT_PRESENT_STATUS
}

export function isRoomParticipantDelta(delta: RoomStateDelta): delta is RoomParticipantDelta {
  return PARTICIPANT_DELTA_KINDS.has(delta.kind)
}

export function participantDeltas(deltas: readonly RoomStateDelta[]): RoomParticipantDelta[] {
  return deltas.filter(isRoomParticipantDelta)
}

function roomFieldChanges(previous: RoomDto, next: RoomDto): RoomUpdatedDelta | null {
  const changes: Partial<Record<keyof RoomFields, RoomFields[keyof RoomFields]>> = {}
  const before: Partial<Record<keyof RoomFields, RoomFields[keyof RoomFields]>> = {}
  for (const key of ROOM_FIELD_KEYS) {
    if (previous[key] !== next[key]) {
      changes[key] = next[key]
      before[key] = previous[key]
    }
  }
  if (Object.keys(changes).length === 0) return null
  // Each key was copied from the matching `RoomDto` field, so the partials are well-typed.
  return {
    kind: 'room_updated',
    changes: changes as Partial<RoomFields>,
    previous: before as Partial<RoomFields>,
  }
}

/**
 * Deltas that turn `previous` into `next`. Participants are matched by `room_participants.id`;
 * only `active` rows count as present. Pure, so UIs and tests can use it directly.
 */
export function diffRoomState(previous: RoomDto, next: RoomDto): RoomStateDelta[] {
  const deltas: RoomStateDelta[] = []
  const before = new Map<string, RoomParticipantDto>()
  for (const participant of previous.participants) {
    if (isPresentParticipant(participant)) before.set(participant.id, participant)
  }
  const after = new Map<string, RoomParticipantDto>()
  for (const participant of next.participants) {
    if (isPresentParticipant(participant)) after.set(participant.id, participant)
  }

  for (const participant of before.values()) {
    if (after.has(participant.id)) continue
    const latest = next.participants.find((p) => p.id === participant.id) ?? participant
    deltas.push({ kind: 'participant_left', participant: latest })
  }
  for (const participant of after.values()) {
    const earlier = before.get(participant.id)
    if (earlier === undefined) {
      deltas.push({ kind: 'participant_joined', participant })
      continue
    }
    if (earlier.mediaState !== participant.mediaState) {
      deltas.push({ kind: 'media_state_changed', participant, previous: earlier.mediaState })
    }
    if (earlier.role !== participant.role) {
      deltas.push({ kind: 'role_changed', participant, previous: earlier.role })
    }
    if (earlier.audienceConsentLevel !== participant.audienceConsentLevel) {
      deltas.push({
        kind: 'consent_changed',
        participant,
        previous: earlier.audienceConsentLevel,
      })
    }
  }

  const updated = roomFieldChanges(previous, next)
  if (updated !== null) deltas.push(updated)
  if (next.status === ROOM_STATUS_ENDED && previous.status !== ROOM_STATUS_ENDED) {
    deltas.push({ kind: 'room_ended' })
  }
  return deltas
}

// ---------------------------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------------------------

export interface SubscribeRoomOptions {
  readonly supabase: RealtimeClientLike
  readonly roomId: RoomId
  /** `room_get(room_id)` (DB_API §3) as the viewer. */
  readonly fetchState: () => Promise<RoomDto>
  /** Every new state with the deltas from the previous one (`[]` for the first snapshot). */
  readonly onRoom: (room: RoomDto, deltas: readonly RoomStateDelta[]) => void
  /** Present participants plus only the participant deltas, for tile animation. */
  readonly onParticipants?: (
    participants: readonly RoomParticipantDto[],
    deltas: readonly RoomParticipantDelta[],
  ) => void
  readonly onStatus?: (status: RealtimeSubscriptionStatus) => void
  readonly diagnostics?: RealtimeDiagnostics
  readonly clock?: RealtimeClock
  readonly pollIntervalMs?: number
  readonly joinTimeoutMs?: number
  /** A state the caller already holds (from `room_start` / `room_join`); still refreshed on start. */
  readonly initialState?: RoomDto
}

export interface RoomSubscription {
  /** Idempotent; stops the channel and timers. */
  unsubscribe(): void
  mode(): RealtimeMode
  status(): RealtimeSubscriptionStatus
  current(): RoomDto | null
  /** Re-fetches the state now (coalesced with an in-flight fetch). */
  refresh(): Promise<void>
}

export function subscribeRoom(options: SubscribeRoomOptions): RoomSubscription {
  const clock = options.clock ?? systemClock
  const diagnostics = options.diagnostics ?? noopDiagnostics
  const pollIntervalMs = options.pollIntervalMs ?? ROOM_POLL_INTERVAL_MS
  const joinTimeoutMs = options.joinTimeoutMs ?? REALTIME_JOIN_TIMEOUT_MS
  const { roomId } = options

  let current: RoomDto | null = options.initialState ?? null
  let stopped = false
  let fetching: Promise<void> | null = null
  let fetchAgain = false
  let fetchFailures = 0
  let cancelPoll: CancelTimer | null = null

  const apply = (next: RoomDto): void => {
    if (stopped) return
    const deltas = current === null ? [] : diffRoomState(current, next)
    current = next
    options.onRoom(next, deltas)
    options.onParticipants?.(
      next.participants.filter(isPresentParticipant),
      participantDeltas(deltas),
    )
    if (next.status === ROOM_STATUS_ENDED) {
      // Nothing further can change; release the channel and timers (spec §62).
      stop()
    }
  }

  const fetchOnce = async (): Promise<void> => {
    try {
      const next = await options.fetchState()
      fetchFailures = 0
      apply(next)
    } catch (error) {
      fetchFailures += 1
      if (fetchFailures === 1) {
        emitDiagnostic(diagnostics, {
          kind: 'realtime_poll_failed',
          channel: 'room',
          roomId,
          attempt: fetchFailures,
          reason: errorReason(error),
        })
      }
    }
  }

  const refresh = (): Promise<void> => {
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
      void refresh().finally(schedulePoll)
    }, pollIntervalMs)
  }

  const supervisor: ChannelSupervisor = createChannelSupervisor({
    supabase: options.supabase,
    topic: roomChangesTopic(roomId),
    clock,
    joinTimeoutMs,
    bind(channel) {
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: REALTIME_SCHEMA,
          table: REALTIME_TABLES.roomParticipants,
          filter: postgresEqFilter('room_id', roomId),
        },
        () => void refresh(),
      )
      channel.on(
        'postgres_changes',
        {
          event: '*',
          schema: REALTIME_SCHEMA,
          table: REALTIME_TABLES.rooms,
          filter: postgresEqFilter('id', roomId),
        },
        () => void refresh(),
      )
    },
    onSubscribed(_channel, recovered) {
      if (recovered) {
        stopPolling()
        emitDiagnostic(diagnostics, { kind: 'realtime_recovered', channel: 'room', roomId })
      }
      // Changes between the last snapshot and the join are not replayed: refresh once.
      void refresh()
    },
    onFailure(reason, failures, degraded, error) {
      if (degraded) {
        emitDiagnostic(diagnostics, {
          kind: 'realtime_fallback',
          channel: 'room',
          roomId,
          attempt: failures,
          reason: error === undefined ? reason : `${reason}: ${errorReason(error)}`,
          code: reason,
        })
        void refresh().finally(schedulePoll)
      }
    },
    ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
  })

  const stop = (): void => {
    if (stopped) return
    stopped = true
    stopPolling()
    supervisor.stop()
  }

  supervisor.start()
  void refresh()

  return {
    unsubscribe: stop,
    mode: () => supervisor.mode(),
    status: () => supervisor.status(),
    current: () => current,
    refresh,
  }
}
