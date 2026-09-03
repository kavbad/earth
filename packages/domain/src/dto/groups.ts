import { z } from 'zod'

import { GROUP_NAME_MAX } from '../constants'
import {
  GroupKindSchema,
  GroupMemberRoleSchema,
  GroupMemberStatusSchema,
  GroupStatusSchema,
} from '../enums'
import { ConversationIdSchema, GroupIdSchema, HumanIdSchema, RoomIdSchema } from '../ids'
import { DisplayNameSchema, HandleSchema } from './claim'
import {
  IsoDateTimeSchema,
  NonNegativeIntSchema,
  NullableUrlSchema,
  PositiveIntSchema,
  UrlSchema,
} from './common'
import { PersonRefDtoSchema } from './identity'

export const GroupNameSchema = z.string().trim().min(1).max(GROUP_NAME_MAX)

/** Active room pointer shown on chats rows and group headers ("Maya + 2 live"). */
export const ActiveRoomRefDtoSchema = z.object({
  roomId: RoomIdSchema,
  participantCount: NonNegativeIntSchema,
})
export type ActiveRoomRefDto = z.infer<typeof ActiveRoomRefDtoSchema>

/** `groups` (spec §22) as seen by a member. A group exists even without a name. */
export const GroupDtoSchema = z.object({
  id: GroupIdSchema,
  name: GroupNameSchema.nullable(),
  avatarUrl: NullableUrlSchema,
  kind: GroupKindSchema,
  status: GroupStatusSchema,
  createdByHumanId: HumanIdSchema,
  /** The group's canonical primary conversation (spec §25). */
  conversationId: ConversationIdSchema,
  memberCount: NonNegativeIntSchema,
  /** `null` when the viewer is not an active member. */
  myRole: GroupMemberRoleSchema.nullable(),
  activeRoom: ActiveRoomRefDtoSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  lastActivityAt: IsoDateTimeSchema.nullable(),
})
export type GroupDto = z.infer<typeof GroupDtoSchema>

/** `group_members` joined with public identity (spec §23). Membership is not friendship. */
export const GroupMemberDtoSchema = z.object({
  humanId: HumanIdSchema,
  displayName: DisplayNameSchema,
  handle: HandleSchema,
  avatarUrl: NullableUrlSchema,
  role: GroupMemberRoleSchema,
  status: GroupMemberStatusSchema,
  joinedAt: IsoDateTimeSchema,
  isFriend: z.boolean(),
})
export type GroupMemberDto = z.infer<typeof GroupMemberDtoSchema>

/** `group_get`: group plus active members (SCREEN 12). */
export const GroupDetailDtoSchema = GroupDtoSchema.extend({
  members: z.array(GroupMemberDtoSchema),
})
export type GroupDetailDto = z.infer<typeof GroupDetailDtoSchema>

/**
 * Public invite preview (spec §24/§46): group name if present, sample members allowed by
 * privacy, member count. Never private messages.
 */
export const GroupInvitePreviewDtoSchema = z.object({
  groupName: GroupNameSchema.nullable(),
  memberCount: NonNegativeIntSchema,
  sampleMembers: z.array(PersonRefDtoSchema),
  alreadyMember: z.boolean(),
  expired: z.boolean(),
})
export type GroupInvitePreviewDto = z.infer<typeof GroupInvitePreviewDtoSchema>

/** The plaintext token is returned exactly once (ARCHITECTURE §5). */
export const GroupInviteCreateDtoSchema = z.object({
  token: z.string().min(1),
  url: UrlSchema,
  expiresAt: IsoDateTimeSchema.nullable(),
})
export type GroupInviteCreateDto = z.infer<typeof GroupInviteCreateDtoSchema>

/** Result of `group_invite_join` for an existing Human (spec §47; DB_API §2). */
export const GroupJoinDtoSchema = z.object({
  groupId: GroupIdSchema,
  conversationId: ConversationIdSchema,
  alreadyMember: z.boolean(),
  /** The Human already had another active membership (spec §98 "second group rate"). */
  isSecondGroup: z.boolean(),
})
export type GroupJoinDto = z.infer<typeof GroupJoinDtoSchema>

export const GroupCreateInputSchema = z.object({
  name: GroupNameSchema.nullish(),
})
export type GroupCreateInput = z.infer<typeof GroupCreateInputSchema>

export const GroupInviteCreateInputSchema = z.object({
  groupId: GroupIdSchema,
  expiresInHours: PositiveIntSchema.max(24 * 30).nullish(),
  maxUses: PositiveIntSchema.max(1000).nullish(),
})
export type GroupInviteCreateInput = z.infer<typeof GroupInviteCreateInputSchema>
