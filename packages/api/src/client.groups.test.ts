import { asGroupId, asHumanId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { RPC, TABLES } from './rpc'
import { earthRejection } from './testing/expect'
import { postgrestRaise } from './testing/fake-supabase'
import * as fixtures from './testing/fixtures'
import { createTestClient } from './testing/harness'

const { IDS } = fixtures
const GROUP = asGroupId(IDS.group)
const MAYA = asHumanId(IDS.maya)

describe('groups', () => {
  it('create maps to group_create(name), null when unnamed', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.groupCreate, fixtures.groupDto())
    const group = await client.groups.create()
    expect(supabase.lastRpc()).toEqual({ name: 'group_create', args: { name: null } })
    expect(group.myRole).toBe('owner')
    await client.groups.create({ name: 'Weekend Crew' })
    expect(supabase.lastRpc().args).toEqual({ name: 'Weekend Crew' })
  })

  it('get parses GroupDetailDto with members', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.groupGet, fixtures.groupDetail())
    const detail = await client.groups.get(GROUP)
    expect(supabase.lastRpc()).toEqual({ name: 'group_get', args: { group_id: IDS.group } })
    expect(detail.members[0]?.handle).toBe('maya')
  })

  it('update and leave map their rpcs', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.groupUpdate, fixtures.groupDto({ name: 'Crew' }))
    await client.groups.update({ groupId: GROUP, name: 'Crew' })
    expect(supabase.lastRpc()).toEqual({
      name: 'group_update',
      args: { group_id: IDS.group, name: 'Crew', avatar_media_id: null },
    })
    supabase.rpcData(RPC.groupLeave, fixtures.groupLeave({ newOwnerHumanId: IDS.maya }))
    const left = await client.groups.leave(GROUP)
    expect(supabase.lastRpc()).toEqual({ name: 'group_leave', args: { group_id: IDS.group } })
    expect(left.newOwnerHumanId).toBe(IDS.maya)
  })

  it('validates ids and names', async () => {
    const { client, supabase } = createTestClient()
    expect((await earthRejection(client.groups.get('nope' as never))).code).toBe('invalid_input')
    expect((await earthRejection(client.groups.update({ groupId: GROUP, name: '' }))).code).toBe(
      'invalid_input',
    )
    expect(supabase.rpcCalls).toHaveLength(0)
  })

  it('converts rpc errors', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcError(RPC.groupGet, postgrestRaise('not_a_member'))
    expect((await earthRejection(client.groups.get(GROUP))).code).toBe('not_a_member')
  })
})

describe('groups.invites', () => {
  it('create converts hours to seconds', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.groupInviteCreate, fixtures.groupInviteCreate())
    const invite = await client.groups.invites.create({
      groupId: GROUP,
      expiresInHours: 2,
      maxUses: 5,
    })
    expect(supabase.lastRpc()).toEqual({
      name: 'group_invite_create',
      args: { group_id: IDS.group, expires_in_seconds: 7200, max_uses: 5 },
    })
    expect(invite.token).toBe('tok_group_1')
    await client.groups.invites.create({ groupId: GROUP })
    expect(supabase.lastRpc().args).toEqual({
      group_id: IDS.group,
      expires_in_seconds: null,
      max_uses: null,
    })
  })

  it('revoke, preview and join map their rpcs', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.groupInviteRevoke, fixtures.groupInviteRevoke())
    expect((await client.groups.invites.revoke(IDS.invite)).status).toBe('revoked')
    expect(supabase.lastRpc()).toEqual({
      name: 'group_invite_revoke',
      args: { invite_id: IDS.invite },
    })
    supabase.rpcData(RPC.groupInvitePreview, fixtures.groupInvitePreview())
    expect((await client.groups.invites.preview('tok')).memberCount).toBe(3)
    expect(supabase.lastRpc()).toEqual({ name: 'group_invite_preview', args: { token: 'tok' } })
    supabase.rpcData(RPC.groupInviteJoin, fixtures.groupJoin({ isSecondGroup: true }))
    expect((await client.groups.invites.join('tok')).isSecondGroup).toBe(true)
    expect(supabase.lastRpc()).toEqual({ name: 'group_invite_join', args: { token: 'tok' } })
    expect((await earthRejection(client.groups.invites.join(''))).code).toBe('invalid_input')
  })

  it('surfaces invite errors', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcError(RPC.groupInviteJoin, postgrestRaise('invite_expired'))
    expect((await earthRejection(client.groups.invites.join('tok'))).code).toBe('invite_expired')
  })

  it('list reads group_invites_view filtered by group and maps rows', async () => {
    const { client, supabase } = createTestClient()
    supabase.onQuery(TABLES.groupInvitesView, { data: [fixtures.groupInviteRow()] })
    const invites = await client.groups.invites.list(GROUP)
    expect(supabase.lastQuery()).toMatchObject({
      table: 'group_invites_view',
      filters: [{ column: 'group_id', operator: 'eq', value: IDS.group }],
      order: { column: 'created_at', ascending: false },
    })
    expect(invites).toEqual([
      {
        id: IDS.invite,
        groupId: IDS.group,
        createdByHumanId: IDS.xavier,
        expiresAt: fixtures.LATER,
        maxUses: null,
        useCount: 2,
        status: 'active',
        createdAt: fixtures.AT,
        revokedAt: null,
      },
    ])
  })
})

describe('groups.members', () => {
  it('remove and setRole map their rpcs', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.groupMemberRemove, fixtures.groupMemberRemove())
    expect((await client.groups.members.remove(GROUP, MAYA)).status).toBe('removed')
    expect(supabase.lastRpc()).toEqual({
      name: 'group_member_remove',
      args: { group_id: IDS.group, human_id: IDS.maya },
    })
    supabase.rpcData(RPC.groupMemberSetRole, fixtures.groupMember({ role: 'moderator' }))
    expect((await client.groups.members.setRole(GROUP, MAYA, 'moderator')).role).toBe('moderator')
    expect(supabase.lastRpc()).toEqual({
      name: 'group_member_set_role',
      args: { group_id: IDS.group, human_id: IDS.maya, role: 'moderator' },
    })
    expect(
      (await earthRejection(client.groups.members.setRole(GROUP, MAYA, 'boss' as never))).code,
    ).toBe('invalid_input')
    // Ownership moves only through group_leave (DB_API §2): `owner` never reaches the database.
    expect(
      (await earthRejection(client.groups.members.setRole(GROUP, MAYA, 'owner' as never))).code,
    ).toBe('invalid_input')
    expect(supabase.rpcCalls.filter((call) => call.name === RPC.groupMemberSetRole)).toHaveLength(1)
    supabase.rpcData(RPC.groupMemberSetRole, fixtures.groupMember({ role: 'member' }))
    expect((await client.groups.members.setRole(GROUP, MAYA, 'member')).role).toBe('member')
  })
})
