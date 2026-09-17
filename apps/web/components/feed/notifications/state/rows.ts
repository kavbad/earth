/**
 * Notification rows (SCREEN 23; spec §86): the stored payload becomes the exact spec copy through
 * `@earth/domain`'s `notificationCopyFromPayload` (the server's rendered title/body is the
 * fallback), the actor faces come from the names the payload carries, and the destination is
 * derived from the object the notification points at. Pure so the mapping is tested without a
 * browser.
 */
import {
  type ConversationId,
  type HumanId,
  type NotificationDto,
  type NotificationId,
  type NotificationPriority,
  type NotificationType,
  type NotificationsPageDto,
  type RoomId,
  asConversationId,
  asRoomId,
  isUuid,
  notificationCopyFromPayload,
} from '@earth/domain'
import { z } from 'zod'

export type NotificationDestination =
  | { readonly kind: 'room'; readonly roomId: RoomId }
  | { readonly kind: 'conversation'; readonly conversationId: ConversationId }
  | { readonly kind: 'profile'; readonly handle: string }
  /** Social notifications carry a name but no handle: search finds the person. */
  | { readonly kind: 'search'; readonly query: string }
  | { readonly kind: 'none' }

export interface NotificationFace {
  readonly displayName: string
  readonly avatarUrl: string | null
}

export interface NotificationRow {
  readonly id: NotificationId
  readonly type: NotificationType
  readonly priority: NotificationPriority
  readonly title: string
  readonly body: string
  readonly unread: boolean
  readonly createdAt: string
  readonly actorHumanId: HumanId | null
  readonly faces: readonly NotificationFace[]
  readonly destination: NotificationDestination
  /** A friend request can be accepted from the row (spec §86 "Maya wants to be friends"). */
  readonly acceptable: boolean
}

const OptionalName = z.string().trim().min(1).optional().catch(undefined)
const OptionalNames = z
  .array(z.string())
  .optional()
  .catch(undefined)
  .transform((names) => (names ?? []).map((n) => n.trim()).filter((n) => n.length > 0))
const OptionalUuid = z.string().optional().catch(undefined)

/** The payload keys the rows read; every one is optional and tolerated when absent. */
const RowPayloadSchema = z.object({
  name: OptionalName,
  senderName: OptionalName,
  names: OptionalNames,
  participantNames: OptionalNames,
  avatarUrls: z.array(z.string()).optional().catch(undefined),
  handle: OptionalName,
  actorHandle: OptionalName,
  conversationId: OptionalUuid,
  roomId: OptionalUuid,
})

function payloadOf(dto: NotificationDto): z.infer<typeof RowPayloadSchema> {
  const parsed = RowPayloadSchema.safeParse(dto.payload)
  return parsed.success ? parsed.data : { names: [], participantNames: [] }
}

/** The people named by the payload, most relevant first (spec §86 examples). */
export function notificationNames(dto: NotificationDto): readonly string[] {
  const payload = payloadOf(dto)
  if (payload.participantNames.length > 0) return payload.participantNames
  if (payload.names.length > 0) return payload.names
  const single = payload.senderName ?? payload.name
  return single === undefined ? [] : [single]
}

export function notificationFaces(dto: NotificationDto): readonly NotificationFace[] {
  const payload = payloadOf(dto)
  const avatars = payload.avatarUrls ?? []
  return notificationNames(dto).map((displayName, index) => ({
    displayName,
    avatarUrl: avatars[index] ?? null,
  }))
}

export function notificationDestination(dto: NotificationDto): NotificationDestination {
  const payload = payloadOf(dto)
  switch (dto.objectType) {
    case 'room':
      return isUuid(dto.objectId)
        ? { kind: 'room', roomId: asRoomId(dto.objectId) }
        : { kind: 'none' }
    case 'conversation':
      return isUuid(dto.objectId)
        ? { kind: 'conversation', conversationId: asConversationId(dto.objectId) }
        : { kind: 'none' }
    case 'message':
    case 'group': {
      const conversationId = payload.conversationId
      return conversationId !== undefined && isUuid(conversationId)
        ? { kind: 'conversation', conversationId: asConversationId(conversationId) }
        : { kind: 'none' }
    }
    case 'human': {
      const handle = payload.handle ?? payload.actorHandle
      if (handle !== undefined) return { kind: 'profile', handle }
      const name = payload.name ?? payload.senderName
      return name === undefined ? { kind: 'none' } : { kind: 'search', query: name }
    }
    case 'post':
      return { kind: 'none' }
    default: {
      const exhaustive: never = dto.objectType
      throw new Error(`Unknown notification object: ${String(exhaustive)}`)
    }
  }
}

/** Spec §86 copy from the payload; the server-rendered title/body when the payload is unusable. */
export function notificationCopyFor(dto: NotificationDto): { title: string; body: string } {
  const rendered = notificationCopyFromPayload(dto.type, dto.payload)
  return rendered ?? { title: dto.title, body: dto.body }
}

export function notificationRow(dto: NotificationDto): NotificationRow {
  const { title, body } = notificationCopyFor(dto)
  return {
    id: dto.id,
    type: dto.type,
    priority: dto.priority,
    title,
    body,
    unread: dto.readAt === null,
    createdAt: dto.createdAt,
    actorHumanId: dto.actorHumanId,
    faces: notificationFaces(dto),
    destination: notificationDestination(dto),
    acceptable: dto.type === 'friend_request' && dto.actorHumanId !== null,
  }
}

/** Every page's notifications in the server's order (priority, then newest), each id once. */
export function mergeNotificationPages(
  pages: readonly NotificationsPageDto[],
): readonly NotificationDto[] {
  const seen = new Set<string>()
  const rows: NotificationDto[] = []
  for (const page of pages) {
    for (const notification of page.notifications) {
      if (seen.has(notification.id)) continue
      seen.add(notification.id)
      rows.push(notification)
    }
  }
  return rows
}

/** Marks one notification read in cached pages (optimistic; the server confirms). */
export function withNotificationRead(
  pages: readonly NotificationsPageDto[],
  id: NotificationId,
  readAt: string,
): NotificationsPageDto[] {
  return pages.map((page) => {
    const index = page.notifications.findIndex((n) => n.id === id && n.readAt === null)
    if (index === -1) return page
    const notifications = page.notifications.map((n) => (n.id === id ? { ...n, readAt } : n))
    return { ...page, notifications, unreadCount: Math.max(0, page.unreadCount - 1) }
  })
}
