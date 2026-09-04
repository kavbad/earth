/**
 * Notifications realtime (SCREEN 23; ARCHITECTURE §5, §8): `@earth/realtime` has no
 * notifications subscription of its own, so this is its channel supervisor bound to
 * `postgres_changes` inserts on `notifications` (in the publication; RLS narrows delivery to the
 * recipient). When the channel degrades the list polls instead — the fallback is a feature.
 */
import type { EarthClient } from '@earth/api'
import { REALTIME_JOIN_TIMEOUT_MS } from '@earth/domain'
import {
  type ChannelSupervisor,
  REALTIME_SCHEMA,
  type RealtimeClientLike,
  type RealtimeClock,
  type RealtimeDiagnostics,
  type RealtimeSubscriptionStatus,
  createChannelSupervisor,
  emitDiagnostic,
  systemClock,
} from '@earth/realtime'

export const NOTIFICATIONS_TABLE = 'notifications' as const
export const NOTIFICATIONS_TOPIC = 'notifications:changes' as const

export function createNotificationDiagnostics(
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

export interface SubscribeNotificationsOptions {
  readonly supabase: RealtimeClientLike
  readonly onChange: () => void
  readonly onStatus?: (status: RealtimeSubscriptionStatus) => void
  readonly diagnostics?: RealtimeDiagnostics
  readonly clock?: RealtimeClock
  readonly joinTimeoutMs?: number
}

export interface NotificationsSubscription {
  unsubscribe(): void
  status(): RealtimeSubscriptionStatus
}

export function subscribeNotifications(
  options: SubscribeNotificationsOptions,
): NotificationsSubscription {
  let stopped = false
  const supervisor: ChannelSupervisor = createChannelSupervisor({
    supabase: options.supabase,
    topic: NOTIFICATIONS_TOPIC,
    clock: options.clock ?? systemClock,
    joinTimeoutMs: options.joinTimeoutMs ?? REALTIME_JOIN_TIMEOUT_MS,
    bind(channel) {
      channel.on(
        'postgres_changes',
        { event: 'INSERT', schema: REALTIME_SCHEMA, table: NOTIFICATIONS_TABLE },
        () => {
          if (!stopped) options.onChange()
        },
      )
    },
    onSubscribed(_channel, recovered) {
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
