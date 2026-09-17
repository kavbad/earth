import { z } from 'zod'

import { PresenceItemTypeSchema, RoomVisibilitySchema, ScopeSchema } from '../enums'
import {
  ConversationIdSchema,
  GroupIdSchema,
  HumanIdSchema,
  PostIdSchema,
  RoomIdSchema,
} from '../ids'
import {
  IsoDateTimeSchema,
  NonNegativeIntSchema,
  NullableCursorSchema,
  NullableUrlSchema,
  UrlSchema,
} from './common'
import { PostViewDtoSchema } from './posts'

/** Every card carries a stable `id` used by the keyset cursor `(score, id)` (ARCHITECTURE §9). */
export const FeedPostCardDtoSchema = PostViewDtoSchema.extend({
  kind: z.literal('post'),
  id: PostIdSchema,
})
export type FeedPostCardDto = z.infer<typeof FeedPostCardDtoSchema>

/** A Live is an active Room whose visibility makes it discoverable (spec §36). Naming is viewer-aware (spec §60). */
export const LiveCardDtoSchema = z.object({
  kind: z.literal('live'),
  id: RoomIdSchema,
  roomId: RoomIdSchema,
  /** "Xavier is live", "Xavier + Kavon are live", "Weekend Crew is live". */
  title: z.string().min(1),
  participantNames: z.array(z.string().min(1)),
  participantAvatars: z.array(NullableUrlSchema),
  participantCount: NonNegativeIntSchema,
  visibility: RoomVisibilitySchema,
  contextTitle: z.string().nullable(),
  startedAt: IsoDateTimeSchema,
  areaName: z.string().nullable(),
})
export type LiveCardDto = z.infer<typeof LiveCardDtoSchema>

/** One item of the presence row (SCREEN 02): "Xavier + Maya live", "Weekend Crew · 3 active", "Sarah nearby". */
export const PresenceItemDtoSchema = z.object({
  type: PresenceItemTypeSchema,
  label: z.string().min(1),
  humanIds: z.array(HumanIdSchema),
  roomId: RoomIdSchema.nullable(),
  conversationId: ConversationIdSchema.nullable(),
  groupId: GroupIdSchema.nullable(),
  avatarUrls: z.array(UrlSchema),
})
export type PresenceItemDto = z.infer<typeof PresenceItemDtoSchema>

/** Rendered only when there is meaningful state — never an empty placeholder. */
export const PresenceCardDtoSchema = z.object({
  kind: z.literal('presence'),
  id: z.string().min(1),
  items: z.array(PresenceItemDtoSchema).min(1),
})
export type PresenceCardDto = z.infer<typeof PresenceCardDtoSchema>

export const FeedCardDtoSchema = z.discriminatedUnion('kind', [
  FeedPostCardDtoSchema,
  LiveCardDtoSchema,
  PresenceCardDtoSchema,
])
export type FeedCardDto = z.infer<typeof FeedCardDtoSchema>

/** `GET /api/feed` result. `snapshotAt` pins later pages to the same candidate set. */
export const FeedPageDtoSchema = z.object({
  cards: z.array(FeedCardDtoSchema),
  nextCursor: NullableCursorSchema,
  snapshotAt: IsoDateTimeSchema,
  scope: ScopeSchema,
  areaName: z.string().nullable(),
})
export type FeedPageDto = z.infer<typeof FeedPageDtoSchema>

/** `GET /api/live` result (SCREEN 13). */
export const LiveListDtoSchema = z.object({
  cards: z.array(LiveCardDtoSchema),
  scope: ScopeSchema,
  areaName: z.string().nullable(),
})
export type LiveListDto = z.infer<typeof LiveListDtoSchema>
