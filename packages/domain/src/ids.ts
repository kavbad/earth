/**
 * Branded uuid identifiers. Every table id is `uuid default gen_random_uuid()` (ARCHITECTURE §5);
 * the brands stop a `GroupId` from being passed where a `HumanId` is expected.
 */
import { z } from 'zod'

import { EarthError } from './errors'

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value)
}

export const UuidSchema = z.uuid()

export const HumanIdSchema = z.uuid().brand<'HumanId'>()
export type HumanId = z.infer<typeof HumanIdSchema>

export const GroupIdSchema = z.uuid().brand<'GroupId'>()
export type GroupId = z.infer<typeof GroupIdSchema>

export const ConversationIdSchema = z.uuid().brand<'ConversationId'>()
export type ConversationId = z.infer<typeof ConversationIdSchema>

export const MessageIdSchema = z.uuid().brand<'MessageId'>()
export type MessageId = z.infer<typeof MessageIdSchema>

export const RoomIdSchema = z.uuid().brand<'RoomId'>()
export type RoomId = z.infer<typeof RoomIdSchema>

export const PostIdSchema = z.uuid().brand<'PostId'>()
export type PostId = z.infer<typeof PostIdSchema>

export const GuestSessionIdSchema = z.uuid().brand<'GuestSessionId'>()
export type GuestSessionId = z.infer<typeof GuestSessionIdSchema>

export const AreaIdSchema = z.uuid().brand<'AreaId'>()
export type AreaId = z.infer<typeof AreaIdSchema>

export const PlaceIdSchema = z.uuid().brand<'PlaceId'>()
export type PlaceId = z.infer<typeof PlaceIdSchema>

export const NotificationIdSchema = z.uuid().brand<'NotificationId'>()
export type NotificationId = z.infer<typeof NotificationIdSchema>

function assertUuid(value: string, brand: string): void {
  if (!isUuid(value)) {
    throw new EarthError('invalid_input', {
      details: { field: brand, reason: 'not_a_uuid' },
      message: `${brand}: not a uuid`,
    })
  }
}

/** Casts a uuid string into a branded id, throwing `EarthError('invalid_input')` if malformed. */
export const asHumanId = (value: string): HumanId => {
  assertUuid(value, 'HumanId')
  return value as HumanId
}
export const asGroupId = (value: string): GroupId => {
  assertUuid(value, 'GroupId')
  return value as GroupId
}
export const asConversationId = (value: string): ConversationId => {
  assertUuid(value, 'ConversationId')
  return value as ConversationId
}
export const asMessageId = (value: string): MessageId => {
  assertUuid(value, 'MessageId')
  return value as MessageId
}
export const asRoomId = (value: string): RoomId => {
  assertUuid(value, 'RoomId')
  return value as RoomId
}
export const asPostId = (value: string): PostId => {
  assertUuid(value, 'PostId')
  return value as PostId
}
export const asGuestSessionId = (value: string): GuestSessionId => {
  assertUuid(value, 'GuestSessionId')
  return value as GuestSessionId
}
export const asAreaId = (value: string): AreaId => {
  assertUuid(value, 'AreaId')
  return value as AreaId
}
export const asPlaceId = (value: string): PlaceId => {
  assertUuid(value, 'PlaceId')
  return value as PlaceId
}
export const asNotificationId = (value: string): NotificationId => {
  assertUuid(value, 'NotificationId')
  return value as NotificationId
}

/** LiveKit participant identity (ARCHITECTURE §10): `h:<human_id>` or `g:<guest_session_id>`. */
export const MEDIA_IDENTITY_PREFIX = { human: 'h', guest: 'g' } as const

export type MediaIdentity = `h:${string}` | `g:${string}`

export const MediaIdentitySchema = z
  .string()
  .regex(/^[hg]:[0-9a-fA-F-]{36}$/)
  .refine((value) => isUuid(value.slice(2)), 'media identity must wrap a uuid') as z.ZodType<
  MediaIdentity,
  string
>

export function mediaIdentityForHuman(humanId: HumanId): MediaIdentity {
  return `${MEDIA_IDENTITY_PREFIX.human}:${humanId}`
}

export function mediaIdentityForGuest(guestSessionId: GuestSessionId): MediaIdentity {
  return `${MEDIA_IDENTITY_PREFIX.guest}:${guestSessionId}`
}

export type ParsedMediaIdentity =
  { kind: 'human'; humanId: HumanId } | { kind: 'guest'; guestSessionId: GuestSessionId }

export function parseMediaIdentity(identity: string): ParsedMediaIdentity | null {
  const prefix = identity.slice(0, 2)
  const id = identity.slice(2)
  if (!isUuid(id)) return null
  if (prefix === `${MEDIA_IDENTITY_PREFIX.human}:`) return { kind: 'human', humanId: id as HumanId }
  if (prefix === `${MEDIA_IDENTITY_PREFIX.guest}:`) {
    return { kind: 'guest', guestSessionId: id as GuestSessionId }
  }
  return null
}
