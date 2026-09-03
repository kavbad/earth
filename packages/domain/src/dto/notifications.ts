import { z } from 'zod'

import {
  NotificationObjectTypeSchema,
  NotificationPrioritySchema,
  NotificationTypeSchema,
  PushPlatformSchema,
} from '../enums'
import { HumanIdSchema, NotificationIdSchema } from '../ids'
import {
  IsoDateTimeSchema,
  JsonObjectSchema,
  NonNegativeIntSchema,
  NullableCursorSchema,
} from './common'

/** `notifications` (spec §40) with rendered title/body (spec §86 copy). */
export const NotificationDtoSchema = z.object({
  id: NotificationIdSchema,
  type: NotificationTypeSchema,
  priority: NotificationPrioritySchema,
  title: z.string().min(1),
  body: z.string(),
  actorHumanId: HumanIdSchema.nullable(),
  objectType: NotificationObjectTypeSchema,
  objectId: z.uuid(),
  payload: JsonObjectSchema,
  readAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
})
export type NotificationDto = z.infer<typeof NotificationDtoSchema>

export const NotificationsPageDtoSchema = z.object({
  notifications: z.array(NotificationDtoSchema),
  nextCursor: NullableCursorSchema,
  unreadCount: NonNegativeIntSchema,
})
export type NotificationsPageDto = z.infer<typeof NotificationsPageDtoSchema>

export const PushTokenRegisterInputSchema = z.object({
  token: z.string().min(1),
  platform: PushPlatformSchema,
})
export type PushTokenRegisterInput = z.infer<typeof PushTokenRegisterInputSchema>
