/**
 * `notifications` and `presence` (DB_API §1, §6; ARCHITECTURE §8, §11; spec PART XIV).
 */
import {
  NOTIFICATIONS_PAGE_SIZE,
  type NotificationId,
  NotificationIdSchema,
  type NotificationsPageDto,
  NotificationsPageDtoSchema,
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
import { RPC } from '../rpc'
import { type Transport, parseInput } from '../transport'

export interface NotificationsNamespace {
  /** `notifications_list(cursor, limit)`: priority rank, then newest first. */
  list(input?: NotificationsListInput): Promise<NotificationsPageDto>
  /** `notification_mark_read(id)`. */
  markRead(notificationId: NotificationId): Promise<void>
  /** `notifications_mark_all_read()`. */
  markAllRead(): Promise<void>
  /** `unreadCount` of a one-item `notifications_list` page (no dedicated RPC in DB_API §6). */
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
const UNREAD_PROBE_LIMIT = 1

export function createNotificationsNamespace(transport: Transport): NotificationsNamespace {
  const list = (input: NotificationsListInput = {}): Promise<NotificationsPageDto> => {
    const parsed = parseInput(NotificationsListInputSchema, input)
    return transport.rpc(
      RPC.notificationsList,
      { cursor: parsed.cursor ?? null, limit: parsed.limit ?? NOTIFICATIONS_PAGE_SIZE },
      NotificationsPageDtoSchema,
    )
  }
  return {
    list,
    markRead(notificationId) {
      const id = parseInput(NotificationIdSchema, notificationId, 'notificationId')
      return transport.rpcVoid(RPC.notificationMarkRead, { id })
    },
    markAllRead: () => transport.rpcVoid(RPC.notificationsMarkAllRead, {}),
    unreadCount: async () => (await list({ limit: UNREAD_PROBE_LIMIT })).unreadCount,
    registerPushToken(input) {
      const parsed = parseInput(PushTokenRegisterInputSchema, input)
      return transport.rpcVoid(RPC.pushTokenRegister, {
        token: parsed.token,
        platform: parsed.platform,
      })
    },
    removePushToken(token) {
      const value = parseInput(PushTokenSchema, token, 'token')
      return transport.rpcVoid(RPC.pushTokenRemove, { token: value })
    },
  }
}

export function createPresenceNamespace(transport: Transport): PresenceNamespace {
  return {
    ping(input = {}) {
      const parsed = parseInput(PresencePingArgsSchema, input)
      return transport.rpcVoid(RPC.presencePing, {
        conversation_id: parsed.conversationId ?? null,
        room_id: parsed.roomId ?? null,
        platform: parsed.platform ?? null,
      })
    },
  }
}
