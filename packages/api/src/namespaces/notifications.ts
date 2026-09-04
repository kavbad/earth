/**
 * `notifications` and `presence` (DB_API §1, §6; ARCHITECTURE §8, §11; spec PART XIV).
 */
import {
  NOTIFICATIONS_PAGE_SIZE,
  type NotificationId,
  NotificationIdSchema,
  type NotificationsPageDto,
  type PushTokenRegisterInput,
  PushTokenRegisterInputSchema,
} from '@earth/domain'
import { z } from 'zod'

import {
  type NotificationsListInput,
  NotificationsListInputSchema,
  type PresencePingArgs,
  PresencePingArgsSchema,
} from '../dto'
import { CALLS } from '../manifest'
import { type Transport, parseInput } from '../transport'

export interface NotificationsNamespace {
  /** `notifications_list(cursor, limit)`: priority rank, then newest first. */
  list(input?: NotificationsListInput): Promise<NotificationsPageDto>
  /** `notification_mark_read(id)`. */
  markRead(notificationId: NotificationId): Promise<void>
  /** `notifications_mark_all_read()`. */
  markAllRead(): Promise<void>
  /** `notifications_unread_count()` (DB_API §6). */
  unreadCount(): Promise<number>
  /** `push_token_register(token, platform)`. */
  registerPushToken(input: PushTokenRegisterInput): Promise<void>
  /** `push_token_remove(token)`. */
  removePushToken(token: string): Promise<void>
}

export interface PresenceNamespace {
  /** `presence_ping(conversation_id, room_id, platform)` every 30 s while foregrounded. */
  ping(input?: PresencePingArgs): Promise<void>
}

const PushTokenSchema = z.string().min(1)

export function createNotificationsNamespace(transport: Transport): NotificationsNamespace {
  return {
    list(input = {}) {
      const parsed = parseInput(NotificationsListInputSchema, input)
      return transport.call(CALLS.notificationsList, {
        cursor: parsed.cursor ?? null,
        limit: parsed.limit ?? NOTIFICATIONS_PAGE_SIZE,
      })
    },
    markRead(notificationId) {
      const id = parseInput(NotificationIdSchema, notificationId, 'notificationId')
      return transport.call(CALLS.notificationsMarkRead, { id })
    },
    markAllRead: () => transport.call(CALLS.notificationsMarkAllRead, {}),
    unreadCount: async () => (await transport.call(CALLS.notificationsUnreadCount, {})).unreadCount,
    registerPushToken(input) {
      const parsed = parseInput(PushTokenRegisterInputSchema, input)
      return transport.call(CALLS.notificationsRegisterPushToken, {
        token: parsed.token,
        platform: parsed.platform,
      })
    },
    removePushToken(token) {
      const value = parseInput(PushTokenSchema, token, 'token')
      return transport.call(CALLS.notificationsRemovePushToken, { token: value })
    },
  }
}

export function createPresenceNamespace(transport: Transport): PresenceNamespace {
  return {
    ping(input = {}) {
      const parsed = parseInput(PresencePingArgsSchema, input)
      return transport.call(CALLS.presencePing, {
        conversation_id: parsed.conversationId ?? null,
        room_id: parsed.roomId ?? null,
        platform: parsed.platform ?? null,
      })
    },
  }
}
