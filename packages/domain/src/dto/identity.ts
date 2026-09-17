import { z } from 'zod'

import { BIO_MAX } from '../constants'
import {
  FriendRequestStateSchema,
  HumanPassStatusSchema,
  HumanStatusSchema,
  ProfileVisibilitySchema,
  RoleKindSchema,
} from '../enums'
import { HumanIdSchema } from '../ids'
import { DisplayNameSchema, HandleSchema } from './claim'
import { NonNegativeIntSchema, NullableUrlSchema } from './common'
import { FlagsDtoSchema } from './flags'
import { HumanContextDtoSchema } from './geo'

/** What anyone allowed to see a Human sees (`public_identities`, spec §17). Never includes Human Pass data. */
export const PublicIdentityDtoSchema = z.object({
  humanId: HumanIdSchema,
  displayName: DisplayNameSchema,
  handle: HandleSchema,
  avatarUrl: NullableUrlSchema,
  bio: z.string().max(BIO_MAX).nullable(),
  /** Home city name when `public_city_visibility` is on, else `null`. */
  cityName: z.string().nullable(),
  profileVisibility: ProfileVisibilitySchema,
})
export type PublicIdentityDto = z.infer<typeof PublicIdentityDtoSchema>

/** Relationship between the viewer and the profile's Human, from the viewer's side. */
export const RelationshipFlagsDtoSchema = z.object({
  isSelf: z.boolean(),
  isFriend: z.boolean(),
  friendRequest: FriendRequestStateSchema,
  isFollowing: z.boolean(),
  isFollowedBy: z.boolean(),
  /** The viewer has blocked this Human. Being blocked by them is never revealed. */
  isBlocked: z.boolean(),
})
export type RelationshipFlagsDto = z.infer<typeof RelationshipFlagsDtoSchema>

export const ProfileCountsDtoSchema = z.object({
  friends: NonNegativeIntSchema,
  followers: NonNegativeIntSchema,
  following: NonNegativeIntSchema,
  posts: NonNegativeIntSchema,
})
export type ProfileCountsDto = z.infer<typeof ProfileCountsDtoSchema>

/** SCREEN 22: avatar, display name, handle, city if shared, mutual friends, actions. */
export const ProfileDtoSchema = z.object({
  identity: PublicIdentityDtoSchema,
  relationship: RelationshipFlagsDtoSchema,
  mutualFriendCount: NonNegativeIntSchema,
  sharedGroupCount: NonNegativeIntSchema,
  counts: ProfileCountsDtoSchema,
  canMessage: z.boolean(),
})
export type ProfileDto = z.infer<typeof ProfileDtoSchema>

/** A minimal person reference used inside other DTOs (participants, samples, previews). */
export const PersonRefDtoSchema = z.object({
  displayName: DisplayNameSchema,
  avatarUrl: NullableUrlSchema,
})
export type PersonRefDto = z.infer<typeof PersonRefDtoSchema>

/**
 * `me_get()` (DB_API §1): who the caller is in the four states of ARCHITECTURE §4. Human-only
 * fields are `null` for visitors and guests; `identity` is `null` until the claim sets one.
 */
export const MeDtoSchema = z.object({
  roleKind: RoleKindSchema,
  humanId: HumanIdSchema.nullable(),
  identity: PublicIdentityDtoSchema.nullable(),
  humanStatus: HumanStatusSchema.nullable(),
  humanPassStatus: HumanPassStatusSchema.nullable(),
  context: HumanContextDtoSchema.nullable(),
  flags: FlagsDtoSchema,
})
export type MeDto = z.infer<typeof MeDtoSchema>
