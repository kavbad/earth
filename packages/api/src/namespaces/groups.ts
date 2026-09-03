/**
 * `groups` (DB_API §2; spec §22–§24, §46–§47).
 */
import {
  type GroupCreateInput,
  GroupCreateInputSchema,
  type GroupDetailDto,
  GroupDetailDtoSchema,
  type GroupDto,
  GroupDtoSchema,
  type GroupId,
  GroupIdSchema,
  type GroupInviteCreateDto,
  GroupInviteCreateDtoSchema,
  type GroupInviteCreateInput,
  GroupInviteCreateInputSchema,
  type GroupInvitePreviewDto,
  GroupInvitePreviewDtoSchema,
  type GroupJoinDto,
  GroupJoinDtoSchema,
  type GroupMemberDto,
  GroupMemberDtoSchema,
  type HumanId,
  HumanIdSchema,
} from '@earth/domain'
import { z } from 'zod'

import {
  type AssignableGroupMemberRole,
  AssignableGroupMemberRoleSchema,
  type GroupInviteDto,
  type GroupInviteRevokeDto,
  GroupInviteRevokeDtoSchema,
  GroupInviteRowsSchema,
  type GroupLeaveDto,
  GroupLeaveDtoSchema,
  type GroupMemberRemoveDto,
  GroupMemberRemoveDtoSchema,
  type GroupUpdateInput,
  GroupUpdateInputSchema,
  groupInviteFromRow,
} from '../dto'
import { RPC, TABLES } from '../rpc'
import { type Transport, parseInput } from '../transport'
import { FILTER_OPERATORS } from '../types'

export interface GroupInvitesNamespace {
  /** `group_invite_create(group_id, expires_in_seconds, max_uses)`; the plaintext token is returned once. */
  create(input: GroupInviteCreateInput): Promise<GroupInviteCreateDto>
  /** `group_invite_revoke(invite_id)` (owner/moderator). */
  revoke(inviteId: string): Promise<GroupInviteRevokeDto>
  /** `group_invite_preview(token)` — public, never messages. */
  preview(token: string): Promise<GroupInvitePreviewDto>
  /** `group_invite_join(token)` for an existing Human. */
  join(token: string): Promise<GroupJoinDto>
  /** Invites of a group the caller created or moderates (`group_invites_view`, never `token_hash`). */
  list(groupId: GroupId): Promise<GroupInviteDto[]>
}

export interface GroupMembersNamespace {
  /** `group_member_remove(group_id, human_id)`. */
  remove(groupId: GroupId, humanId: HumanId): Promise<GroupMemberRemoveDto>
  /** `group_member_set_role(group_id, human_id, role)` (owner): `moderator` or `member` — ownership moves only through `group_leave`. */
  setRole(
    groupId: GroupId,
    humanId: HumanId,
    role: AssignableGroupMemberRole,
  ): Promise<GroupMemberDto>
}

export interface GroupsNamespace {
  /** `group_create(name)`: group + owner membership + conversation. */
  create(input?: GroupCreateInput): Promise<GroupDto>
  /** `group_get(group_id)` with members. */
  get(groupId: GroupId): Promise<GroupDetailDto>
  /** `group_update(group_id, name, avatar_media_id)`. */
  update(input: GroupUpdateInput): Promise<GroupDto>
  /** `group_leave(group_id)`: ownership transfer / archive per DB_API §2. */
  leave(groupId: GroupId): Promise<GroupLeaveDto>
  readonly invites: GroupInvitesNamespace
  readonly members: GroupMembersNamespace
}

const TokenSchema = z.string().min(1)
const InviteIdSchema = z.uuid()
const SECONDS_PER_HOUR = 3600
const INVITE_COLUMNS =
  'id, group_id, created_by, expires_at, max_uses, use_count, status, created_at, revoked_at' as const
const INVITE_GROUP_COLUMN = 'group_id' as const
const INVITE_ORDER_COLUMN = 'created_at' as const

export function createGroupsNamespace(transport: Transport): GroupsNamespace {
  const invites: GroupInvitesNamespace = {
    create(input) {
      const parsed = parseInput(GroupInviteCreateInputSchema, input)
      return transport.rpc(
        RPC.groupInviteCreate,
        {
          group_id: parsed.groupId,
          expires_in_seconds:
            parsed.expiresInHours === null || parsed.expiresInHours === undefined
              ? null
              : parsed.expiresInHours * SECONDS_PER_HOUR,
          max_uses: parsed.maxUses ?? null,
        },
        GroupInviteCreateDtoSchema,
      )
    },
    revoke(inviteId) {
      const id = parseInput(InviteIdSchema, inviteId, 'inviteId')
      return transport.rpc(RPC.groupInviteRevoke, { invite_id: id }, GroupInviteRevokeDtoSchema)
    },
    preview(token) {
      const value = parseInput(TokenSchema, token, 'token')
      return transport.rpc(RPC.groupInvitePreview, { token: value }, GroupInvitePreviewDtoSchema)
    },
    join(token) {
      const value = parseInput(TokenSchema, token, 'token')
      return transport.rpc(RPC.groupInviteJoin, { token: value }, GroupJoinDtoSchema)
    },
    async list(groupId) {
      const id = parseInput(GroupIdSchema, groupId, 'groupId')
      const rows = await transport.query(
        `select ${TABLES.groupInvitesView}`,
        (table) =>
          table
            .select(INVITE_COLUMNS)
            .filter(INVITE_GROUP_COLUMN, FILTER_OPERATORS.eq, id)
            .order(INVITE_ORDER_COLUMN, { ascending: false }),
        TABLES.groupInvitesView,
        GroupInviteRowsSchema,
      )
      return rows.map(groupInviteFromRow)
    },
  }

  const members: GroupMembersNamespace = {
    remove(groupId, humanId) {
      return transport.rpc(
        RPC.groupMemberRemove,
        {
          group_id: parseInput(GroupIdSchema, groupId, 'groupId'),
          human_id: parseInput(HumanIdSchema, humanId, 'humanId'),
        },
        GroupMemberRemoveDtoSchema,
      )
    },
    setRole(groupId, humanId, role) {
      return transport.rpc(
        RPC.groupMemberSetRole,
        {
          group_id: parseInput(GroupIdSchema, groupId, 'groupId'),
          human_id: parseInput(HumanIdSchema, humanId, 'humanId'),
          role: parseInput(AssignableGroupMemberRoleSchema, role, 'role'),
        },
        GroupMemberDtoSchema,
      )
    },
  }

  return {
    create(input = {}) {
      const parsed = parseInput(GroupCreateInputSchema, input)
      return transport.rpc(RPC.groupCreate, { name: parsed.name ?? null }, GroupDtoSchema)
    },
    get(groupId) {
      const id = parseInput(GroupIdSchema, groupId, 'groupId')
      return transport.rpc(RPC.groupGet, { group_id: id }, GroupDetailDtoSchema)
    },
    update(input) {
      const parsed = parseInput(GroupUpdateInputSchema, input)
      return transport.rpc(
        RPC.groupUpdate,
        {
          group_id: parsed.groupId,
          name: parsed.name ?? null,
          avatar_media_id: parsed.avatarMediaId ?? null,
        },
        GroupDtoSchema,
      )
    },
    leave(groupId) {
      const id = parseInput(GroupIdSchema, groupId, 'groupId')
      return transport.rpc(RPC.groupLeave, { group_id: id }, GroupLeaveDtoSchema)
    },
    invites,
    members,
  }
}
