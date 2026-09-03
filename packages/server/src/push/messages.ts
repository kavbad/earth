/**
 * Push message assembly (ARCHITECTURE §11; spec §12, §86): a notification row plus a device token
 * become one Expo message whose title/body are the exact spec copy (`@earth/domain`
 * notifications) and whose `data` lets the app deep-link.
 */
import {
  type NotificationObjectType,
  NotificationObjectTypeSchema,
  type NotificationPriority,
  NotificationPrioritySchema,
  type NotificationType,
  NotificationTypeSchema,
  IsoDateTimeSchema,
  JsonObjectSchema,
  PushPlatformSchema,
  isUuid,
  notificationCopyFromPayload,
} from '@earth/domain'
import { z } from 'zod'

import type { PushMessage, PushPriority } from '../deps'

/** One row of `notifications_unsent(limit)` (DB_API §6): the notification, its tokens, presence. */
export const UnsentNotificationRowSchema = z.object({
  id: z.uuid(),
  recipientHumanId: z.uuid(),
  type: NotificationTypeSchema,
  priority: NotificationPrioritySchema,
  actorHumanId: z.uuid().nullable().default(null),
  objectType: NotificationObjectTypeSchema,
  objectId: z.uuid(),
  payload: JsonObjectSchema.default({}),
  createdAt: IsoDateTimeSchema,
  pushTokens: z
    .array(z.object({ token: z.string().min(1), platform: PushPlatformSchema }))
    .default([]),
  presence: z
    .object({
      lastActiveAt: IsoDateTimeSchema.nullable().default(null),
      activeConversationId: z.uuid().nullable().default(null),
      activeRoomId: z.uuid().nullable().default(null),
    })
    .nullable()
    .default(null),
})
export type UnsentNotificationRow = z.infer<typeof UnsentNotificationRowSchema>

export const UnsentNotificationsResultSchema = z.union([
  z.array(UnsentNotificationRowSchema),
  z
    .object({ notifications: z.array(UnsentNotificationRowSchema) })
    .transform((r) => r.notifications),
  z.null().transform(() => [] as UnsentNotificationRow[]),
])

/** Priorities pushed with `high` (delivered immediately, may wake the device). */
export const HIGH_PUSH_PRIORITIES: ReadonlySet<NotificationPriority> =
  new Set<NotificationPriority>(['critical_social', 'high'])

export function pushPriorityFor(priority: NotificationPriority): PushPriority {
  return HIGH_PUSH_PRIORITIES.has(priority) ? 'high' : 'normal'
}

/** Android channel per type family so people can tune them. */
export const PUSH_CHANNELS = { live: 'live', messages: 'messages', social: 'social' } as const
export type PushChannel = (typeof PUSH_CHANNELS)[keyof typeof PUSH_CHANNELS]

export function pushChannelFor(type: NotificationType): PushChannel {
  switch (type) {
    case 'friend_live':
    case 'multi_live':
    case 'group_live':
      return PUSH_CHANNELS.live
    case 'direct_message':
    case 'group_message':
      return PUSH_CHANNELS.messages
    case 'friend_request':
    case 'friend_accepted':
    case 'follow':
    case 'group_invitation':
      return PUSH_CHANNELS.social
  }
}

/** `data` of every push message (a type alias so it satisfies the record shape of `PushMessage.data`). */
export type PushData = {
  readonly notificationId: string
  readonly type: NotificationType
  readonly objectType: NotificationObjectType
  readonly objectId: string
  readonly roomId?: string
  readonly conversationId?: string
}

function uuidIn(payload: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = payload[key]
  return typeof value === 'string' && isUuid(value) ? value : undefined
}

/** The conversation a notification points at, if any (message rows carry it in the payload). */
export function conversationIdOf(
  row: Pick<UnsentNotificationRow, 'objectType' | 'objectId' | 'payload'>,
): string | undefined {
  if (row.objectType === 'conversation') return row.objectId
  return uuidIn(row.payload, 'conversationId')
}

export function roomIdOf(
  row: Pick<UnsentNotificationRow, 'objectType' | 'objectId' | 'payload'>,
): string | undefined {
  if (row.objectType === 'room') return row.objectId
  return uuidIn(row.payload, 'roomId')
}

export function pushDataFor(row: UnsentNotificationRow): PushData {
  const data: { -readonly [K in keyof PushData]: PushData[K] } = {
    notificationId: row.id,
    type: row.type,
    objectType: row.objectType,
    objectId: row.objectId,
  }
  const roomId = roomIdOf(row)
  if (roomId !== undefined) data.roomId = roomId
  const conversationId = conversationIdOf(row)
  if (conversationId !== undefined) data.conversationId = conversationId
  return data
}

/** The row's tokens with repeats removed (one push per device, whatever the join returned). */
export function distinctPushTokens(
  row: Pick<UnsentNotificationRow, 'pushTokens'>,
): UnsentNotificationRow['pushTokens'] {
  const seen = new Set<string>()
  return row.pushTokens.filter((token) => {
    if (seen.has(token.token)) return false
    seen.add(token.token)
    return true
  })
}

/**
 * Messages for one notification, one per distinct token. `null` when the stored payload cannot
 * produce the spec copy (a database bug: better no push than wrong words).
 */
export function pushMessagesFor(row: UnsentNotificationRow): readonly PushMessage[] | null {
  const copy = notificationCopyFromPayload(row.type, row.payload)
  if (copy === null) return null
  const data = pushDataFor(row)
  const priority = pushPriorityFor(row.priority)
  const channelId = pushChannelFor(row.type)
  return distinctPushTokens(row).map((token) => ({
    to: token.token,
    title: copy.title,
    body: copy.body,
    data,
    priority,
    sound: 'default',
    channelId,
  }))
}
