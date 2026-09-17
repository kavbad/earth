import { z } from 'zod'

import { FriendRequestStateSchema } from '../enums'
import { HumanIdSchema } from '../ids'
import { IsoDateTimeSchema } from './common'

export const HumanTargetInputSchema = z.object({
  humanId: HumanIdSchema,
})
export type HumanTargetInput = z.infer<typeof HumanTargetInputSchema>

/** Result of `friend_request` / `friend_accept` / `friend_remove` / `follow` / `unfollow`. */
export const RelationshipChangeDtoSchema = z.object({
  humanId: HumanIdSchema,
  isFriend: z.boolean(),
  friendRequest: FriendRequestStateSchema,
  isFollowing: z.boolean(),
  updatedAt: IsoDateTimeSchema,
})
export type RelationshipChangeDto = z.infer<typeof RelationshipChangeDtoSchema>

export const PresencePingInputSchema = z.object({
  conversationId: z.uuid().nullish(),
})
export type PresencePingInput = z.infer<typeof PresencePingInputSchema>
