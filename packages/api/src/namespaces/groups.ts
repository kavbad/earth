/**
 * `groups` (DB_API §2; spec §22–§24, §46–§47).
 */
import {
  type GroupCreateInput,
  GroupCreateInputSchema,
  type GroupDetailDto,
  type GroupDto,
  type GroupId,
  GroupIdSchema,
  type GroupInviteCreateDto,
  type GroupInviteCreateInput,
  GroupInviteCreateInputSchema,
  type GroupInvitePreviewDto,
  type GroupJoinDto,
  type GroupMemberDto,
  type HumanId,
  HumanIdSchema,
} from '@earth/domain'
import { z } from 'zod'

import {
  type AssignableGroupMemberRole,
  AssignableGroupMemberRoleSchema,
  type GroupInviteDto,
  type GroupInviteRevokeDto,
  GroupInviteRowsSchema,
  type GroupLeaveDto,
  type GroupMemberRemoveDto,
  type GroupUpdateInput,
  GroupUpdateInputSchema,
  groupInviteFromRow,
} from '../dto'
import { CALLS } from '../manifest'
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
const INVITE_COLUMNS = CALLS.groupsInvitesList.args.join(', ')
const INVITE_GROUP_COLUMN = 'group_id' as const
const INVITE_ORDER_COLUMN = 'created_at' as const

export function createGroupsNamespace(transport: Transport): GroupsNamespace {
  const invites: GroupInvitesNamespace = {
    create(input) {
      const parsed = parseInput(GroupInviteCreateInputSchema, input)
      return transport.call(CALLS.groupsInvitesCreate, {
        group_id: parsed.groupId,
        expires_in_seconds:
          parsed.expiresInHours === null || parsed.expiresInHours === undefined
            ? null
            : parsed.expiresInHours * SECONDS_PER_HOUR,
        max_uses: parsed.maxUses ?? null,
      })
    },
    revoke(inviteId) {
      const id = parseInput(InviteIdSchema, inviteId, 'inviteId')
      return transport.call(CALLS.groupsInvitesRevoke, { invite_id: id })
    },
    preview(token) {
      const value = parseInput(TokenSchema, token, 'token')
      return transport.call(CALLS.groupsInvitesPreview, { token: value })
    },
    join(token) {
      const value = parseInput(TokenSchema, token, 'token')
      return transport.call(CALLS.groupsInvitesJoin, { token: value })
    },
    async list(groupId) {
      const id = parseInput(GroupIdSchema, groupId, 'groupId')
      const rows = await transport.query(
        `select ${CALLS.groupsInvitesList.table}`,
        (table) =>
          table
            .select(INVITE_COLUMNS)
            .filter(INVITE_GROUP_COLUMN, FILTER_OPERATORS.eq, id)
            .order(INVITE_ORDER_COLUMN, { ascending: false }),
        CALLS.groupsInvitesList.table,
        GroupInviteRowsSchema,
      )
      return rows.map(groupInviteFromRow)
    },
  }

  const members: GroupMembersNamespace = {
    remove(groupId, humanId) {
      return transport.call(CALLS.groupsMembersRemove, {
        group_id: parseInput(GroupIdSchema, groupId, 'groupId'),
        human_id: parseInput(HumanIdSchema, humanId, 'humanId'),
      })
    },
    setRole(groupId, humanId, role) {
      return transport.call(CALLS.groupsMembersSetRole, {
        group_id: parseInput(GroupIdSchema, groupId, 'groupId'),
        human_id: parseInput(HumanIdSchema, humanId, 'humanId'),
        role: parseInput(AssignableGroupMemberRoleSchema, role, 'role'),
      })
    },
  }

  return {
    create(input = {}) {
      const parsed = parseInput(GroupCreateInputSchema, input)
      return transport.call(CALLS.groupsCreate, { name: parsed.name ?? null })
    },
    get(groupId) {
      const id = parseInput(GroupIdSchema, groupId, 'groupId')
      return transport.call(CALLS.groupsGet, { group_id: id })
    },
    update(input) {
      const parsed = parseInput(GroupUpdateInputSchema, input)
      return transport.call(CALLS.groupsUpdate, {
        group_id: parsed.groupId,
        name: parsed.name ?? null,
        avatar_media_id: parsed.avatarMediaId ?? null,
      })
    },
    leave(groupId) {
      const id = parseInput(GroupIdSchema, groupId, 'groupId')
      return transport.call(CALLS.groupsLeave, { group_id: id })
    },
    invites,
    members,
  }
}
