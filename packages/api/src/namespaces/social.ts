/**
 * `social` and `safety` (DB_API §1, §7; spec §20–§21, §81–§82).
 */
import {
  BlockDtoSchema,
  type BlocksListDto,
  BlocksListDtoSchema,
  type HumanId,
  HumanIdSchema,
  type ProfileDto,
  ProfileDtoSchema,
  type RelationshipChangeDto,
  RelationshipChangeDtoSchema,
  type ReportDto,
  ReportDtoSchema,
  type ReportInput,
  ReportInputSchema,
} from '@earth/domain'
import { z } from 'zod'

import { HandleLookupSchema } from '../dto'
import { RPC } from '../rpc'
import { arrayOrKeyed } from '../schemas'
import { type Transport, parseInput } from '../transport'

/** `block_set` (DB_API §1): the relationship after the change plus the block flag. */
export const BlockChangeDtoSchema = RelationshipChangeDtoSchema.extend({ isBlocked: z.boolean() })
export type BlockChangeDto = z.infer<typeof BlockChangeDtoSchema>

export interface SocialNamespace {
  /** `profile_get(handle)` respecting visibility and blocks; `@Maya` / `MAYA` look up `maya` (handles are case-insensitive). */
  profile(handle: string): Promise<ProfileDto>
  /** `friend_request_send(target_human_id)`; accepts a reverse pending request when one exists. */
  friendRequest(humanId: HumanId): Promise<RelationshipChangeDto>
  /** `friend_request_accept(source_human_id)`. */
  acceptFriend(humanId: HumanId): Promise<RelationshipChangeDto>
  /** `friend_request_decline(source_human_id)`. */
  declineFriend(humanId: HumanId): Promise<RelationshipChangeDto>
  /** `friend_remove(other_human_id)`. */
  removeFriend(humanId: HumanId): Promise<RelationshipChangeDto>
  /** `follow_set(target_human_id, following)`. */
  setFollow(humanId: HumanId, following: boolean): Promise<RelationshipChangeDto>
  /** `block_set(target_human_id, true)`: also removes friend/pending/follow edges and shares. */
  block(humanId: HumanId): Promise<BlockChangeDto>
  /** `block_set(target_human_id, false)`. */
  unblock(humanId: HumanId): Promise<BlockChangeDto>
  /** `blocks_list()`. */
  blocks(): Promise<BlocksListDto>
}

export interface SafetyNamespace {
  /** `report_create(target_type, target_id, reason, details)`; Humans and Guests may report. */
  report(input: ReportInput): Promise<ReportDto>
  /** `reports_mine()`. */
  myReports(): Promise<ReportDto[]>
}

const BlocksResultSchema = z.union([
  BlocksListDtoSchema,
  z.array(BlockDtoSchema).transform((blocks): BlocksListDto => ({ blocks })),
])
const ReportsResultSchema = arrayOrKeyed(ReportDtoSchema, 'reports')

export function createSocialNamespace(transport: Transport): SocialNamespace {
  const humanId = (value: HumanId): HumanId =>
    parseInput(HumanIdSchema, value, 'humanId') as HumanId
  const relationship = (rpc: string, args: Readonly<Record<string, unknown>>) =>
    transport.rpc(rpc, args, RelationshipChangeDtoSchema)
  const blockSet = (target: HumanId, blocked: boolean) =>
    transport.rpc(RPC.blockSet, { target_human_id: humanId(target), blocked }, BlockChangeDtoSchema)

  return {
    profile(handle) {
      const value = parseInput(HandleLookupSchema, handle, 'handle')
      return transport.rpc(RPC.profileGet, { handle: value }, ProfileDtoSchema)
    },
    friendRequest: (target) =>
      relationship(RPC.friendRequestSend, { target_human_id: humanId(target) }),
    acceptFriend: (source) =>
      relationship(RPC.friendRequestAccept, { source_human_id: humanId(source) }),
    declineFriend: (source) =>
      relationship(RPC.friendRequestDecline, { source_human_id: humanId(source) }),
    removeFriend: (other) => relationship(RPC.friendRemove, { other_human_id: humanId(other) }),
    setFollow: (target, following) =>
      relationship(RPC.followSet, {
        target_human_id: humanId(target),
        following: parseInput(z.boolean(), following, 'following'),
      }),
    block: (target) => blockSet(target, true),
    unblock: (target) => blockSet(target, false),
    blocks: () => transport.rpc(RPC.blocksList, {}, BlocksResultSchema),
  }
}

export function createSafetyNamespace(transport: Transport): SafetyNamespace {
  return {
    report(input) {
      const parsed = parseInput(ReportInputSchema, input)
      return transport.rpc(
        RPC.reportCreate,
        {
          target_type: parsed.targetType,
          target_id: parsed.targetId,
          reason: parsed.reason,
          details: parsed.details,
        },
        ReportDtoSchema,
      )
    },
    myReports: () => transport.rpc(RPC.reportsMine, {}, ReportsResultSchema),
  }
}
