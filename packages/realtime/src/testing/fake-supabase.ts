/**
 * In-memory stand-in for supabase-js Realtime: records bindings and lets tests push statuses,
 * `postgres_changes` payloads and presence syncs into subscribed channels.
 */
import {
  type PostgresChangeCallback,
  type PostgresChangePayload,
  type PostgresChangeType,
  type PostgresChangesFilter,
  type PresenceStateLike,
  type RealtimeChannelLike,
  type RealtimeChannelOptionsLike,
  type RealtimeClientLike,
  type RealtimeSubscribeStatus,
} from '../channel'

export interface FakePostgresBinding {
  readonly filter: PostgresChangesFilter
  readonly callback: PostgresChangeCallback
}

export interface FakeChannel extends RealtimeChannelLike {
  readonly topic: string
  readonly options: RealtimeChannelOptionsLike | undefined
  readonly postgresBindings: FakePostgresBinding[]
  readonly presenceSyncListeners: Array<() => void>
  readonly tracked: Array<Record<string, unknown>>
  untrackCalls: number
  subscribeCalls: number
  removed: boolean
  /** Simulates the server reporting a subscribe status. */
  emitStatus(status: RealtimeSubscribeStatus, error?: Error): void
  /** Delivers a row change to every matching `postgres_changes` binding. */
  emitChange(
    table: string,
    eventType: PostgresChangeType,
    row: Record<string, unknown>,
    old?: Record<string, unknown>,
  ): void
  setPresenceState(state: PresenceStateLike): void
  emitPresenceSync(): void
}

export interface FakeSupabase extends RealtimeClientLike {
  readonly channels: FakeChannel[]
  /** Channels created and not yet removed. */
  active(): FakeChannel[]
  latest(): FakeChannel
  /** When set, `track()` rejects with this error. */
  trackError: Error | null
}

function matches(
  binding: FakePostgresBinding,
  table: string,
  eventType: PostgresChangeType,
): boolean {
  return (
    binding.filter.table === table &&
    (binding.filter.event === '*' || binding.filter.event === eventType)
  )
}

export function createFakeSupabase(): FakeSupabase {
  const channels: FakeChannel[] = []
  const client: FakeSupabase = {
    channels,
    trackError: null,
    active: () => channels.filter((c) => !c.removed),
    latest() {
      const last = channels[channels.length - 1]
      if (last === undefined) throw new Error('no channel created')
      return last
    },
    channel(topic, options) {
      let statusCallback: ((status: RealtimeSubscribeStatus, error?: Error) => void) | undefined
      let presenceState: PresenceStateLike = {}
      const channel: FakeChannel = {
        topic,
        options,
        postgresBindings: [],
        presenceSyncListeners: [],
        tracked: [],
        untrackCalls: 0,
        subscribeCalls: 0,
        removed: false,
        on(type: 'postgres_changes' | 'presence', filter: unknown, callback: unknown) {
          if (type === 'postgres_changes') {
            channel.postgresBindings.push({
              filter: filter as PostgresChangesFilter,
              callback: callback as PostgresChangeCallback,
            })
          } else {
            channel.presenceSyncListeners.push(callback as () => void)
          }
          return channel
        },
        subscribe(callback) {
          channel.subscribeCalls += 1
          statusCallback = callback
          return channel
        },
        async track(payload) {
          if (client.trackError !== null) throw client.trackError
          channel.tracked.push(payload)
          return 'ok'
        },
        async untrack() {
          channel.untrackCalls += 1
          return 'ok'
        },
        presenceState: () => presenceState,
        emitStatus(status, error) {
          statusCallback?.(status, error)
        },
        emitChange(table, eventType, row, old = {}) {
          const payload: PostgresChangePayload = {
            eventType,
            schema: 'public',
            table,
            new: eventType === 'DELETE' ? {} : row,
            old: eventType === 'DELETE' ? row : old,
          }
          for (const binding of channel.postgresBindings) {
            if (matches(binding, table, eventType)) binding.callback(payload)
          }
        },
        setPresenceState(state) {
          presenceState = state
        },
        emitPresenceSync() {
          for (const listener of channel.presenceSyncListeners) listener()
        },
      }
      channels.push(channel)
      return channel
    },
    async removeChannel(channel) {
      const fake = channels.find((c) => c === channel)
      if (fake !== undefined) fake.removed = true
      return 'ok'
    },
  }
  return client
}
