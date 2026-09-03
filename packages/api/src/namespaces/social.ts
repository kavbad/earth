/**
 * `social` and `safety` (DB_API §1, §7; spec §20–§21, §81–§82).
 */
import {
  type BlocksListDto,
  type HumanId,
  HumanIdSchema,
  type ProfileDto,
  type RelationshipChangeDto,
  type ReportDto,
  type ReportInput,
  ReportInputSchema,
} from '@earth/domain'
import { z } from 'zod'

import { type BlockChangeDto, HandleLookupSchema } from '../dto'
import { CALLS } from '../manifest'
import { type Transport, parseInput } from '../transport'

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

export function createSocialNamespace(transport: Transport): SocialNamespace {
  const humanId = (value: HumanId): HumanId =>
    parseInput(HumanIdSchema, value, 'humanId') as HumanId

  return {
    profile(handle) {
      const value = parseInput(HandleLookupSchema, handle, 'handle')
      return transport.call(CALLS.socialProfile, { handle: value })
    },
    friendRequest: (target) =>
      transport.call(CALLS.socialFriendRequest, { target_human_id: humanId(target) }),
    acceptFriend: (source) =>
      transport.call(CALLS.socialAcceptFriend, { source_human_id: humanId(source) }),
    declineFriend: (source) =>
      transport.call(CALLS.socialDeclineFriend, { source_human_id: humanId(source) }),
    removeFriend: (other) =>
      transport.call(CALLS.socialRemoveFriend, { other_human_id: humanId(other) }),
    setFollow: (target, following) =>
      transport.call(CALLS.socialSetFollow, {
        target_human_id: humanId(target),
        following: parseInput(z.boolean(), following, 'following'),
      }),
    block: (target) =>
      transport.call(CALLS.socialBlock, { target_human_id: humanId(target), blocked: true }),
    unblock: (target) =>
      transport.call(CALLS.socialUnblock, { target_human_id: humanId(target), blocked: false }),
    blocks: () => transport.call(CALLS.socialBlocks, {}),
  }
}

export function createSafetyNamespace(transport: Transport): SafetyNamespace {
  return {
    report(input) {
      const parsed = parseInput(ReportInputSchema, input)
      return transport.call(CALLS.safetyReport, {
        target_type: parsed.targetType,
        target_id: parsed.targetId,
        reason: parsed.reason,
        details: parsed.details,
      })
    },
    myReports: () => transport.call(CALLS.safetyMyReports, {}),
  }
}
