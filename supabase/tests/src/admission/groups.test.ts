import {
  GroupDetailDtoSchema,
  GroupDtoSchema,
  GroupInviteCreateDtoSchema,
  GroupInvitePreviewDtoSchema,
  GroupJoinDtoSchema,
  GroupMemberDtoSchema,
} from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  addMember,
  befriend,
  block,
  count,
  createGroup,
  createGuest,
  createHuman,
  createInvite,
  scalar,
  type GroupFixture,
  type Human,
} from './fixtures'

const NIL = '00000000-0000-0000-0000-000000000000'

describe('groups (spec §22–24, §47; DB_API §2)', () => {
  let db: TestDb
  let owner: Human
  let mod: Human
  let member: Human
  let outsider: Human
  let pending: Human
  let guest: { userId: string; as: RoleSpec }
  let group: GroupFixture

  beforeAll(async () => {
    db = await createTestDb()
    owner = await createHuman(db, { handle: 'owner', displayName: 'Owner' })
    mod = await createHuman(db, { handle: 'mod', displayName: 'Mod' })
    member = await createHuman(db, { handle: 'member', displayName: 'Member' })
    outsider = await createHuman(db, { handle: 'outsider', displayName: 'Outsider' })
    pending = await createHuman(db, { handle: 'pend', status: 'pending' })
    guest = await createGuest(db)
    group = await createGroup(db, owner, 'Weekend Crew')
    await addMember(db, group, mod, 'moderator')
    await addMember(db, group, member, 'member')
  })

  afterAll(async () => {
    await db.drop()
  })

  it('group_create makes a group with owner membership and a canonical conversation (GroupDto)', async () => {
    const dto = GroupDtoSchema.parse(
      await db.rpc('group_create', { name: '  College  ' }, owner.as),
    )
    expect(dto).toMatchObject({
      name: 'College',
      kind: 'persistent',
      status: 'active',
      createdByHumanId: owner.humanId,
      memberCount: 1,
      myRole: 'owner',
      activeRoom: null,
      avatarUrl: null,
    })
    expect(
      await scalar(db, 'group_id from public.conversations where id = $1', [dto.conversationId]),
    ).toBe(dto.id)
    expect(
      await count(db, 'public.conversation_members', 'conversation_id = $1 and human_id = $2', [
        dto.conversationId,
        owner.humanId,
      ]),
    ).toBe(1)
    // A group exists even without a name.
    expect(GroupDtoSchema.parse(await db.rpc('group_create', {}, owner.as)).name).toBeNull()
    await db.expectError(
      db.rpc('group_create', { name: 'x'.repeat(61) }, owner.as),
      'invalid_input',
    )
    await db.expectError(db.rpc('group_create', { name: 'X' }, 'visitor'), 'not_authenticated')
    await db.expectError(db.rpc('group_create', { name: 'X' }, guest.as), 'not_a_human')
    await db.expectError(db.rpc('group_create', { name: 'X' }, pending.as), 'not_a_human')
  })

  it('group_get returns members (active Humans only) and invites for moderators (GroupDetailDto)', async () => {
    await db.expectError(db.rpc('group_get', { group_id: NIL }, owner.as), 'group_not_found')
    await db.expectError(
      db.rpc('group_get', { group_id: group.groupId }, outsider.as),
      'not_a_member',
    )
    await db.expectError(
      db.rpc('group_get', { group_id: group.groupId }, 'visitor'),
      'not_authenticated',
    )
    await befriend(db, owner, member)
    const raw = await db.rpc<Record<string, unknown>>(
      'group_get',
      { group_id: group.groupId },
      owner.as,
    )
    const detail = GroupDetailDtoSchema.parse(raw)
    expect(detail.memberCount).toBe(3)
    expect(detail.members.map((m) => [m.handle, m.role, m.isFriend])).toEqual([
      ['owner', 'owner', false],
      ['mod', 'moderator', false],
      ['member', 'member', true],
    ])
    expect(raw).toHaveProperty('invites')
    const asMember = await db.rpc<Record<string, unknown>>(
      'group_get',
      { group_id: group.groupId },
      member.as,
    )
    expect(asMember).not.toHaveProperty('invites')
    expect(GroupDetailDtoSchema.parse(asMember).myRole).toBe('member')
    // A suspended member disappears from the list (and pending Humans can never be members).
    const suspended = await createHuman(db, { handle: 'susp' })
    await addMember(db, group, suspended)
    await db.sql.query("update public.humans set status = 'suspended' where id = $1", [
      suspended.humanId,
    ])
    const after = GroupDetailDtoSchema.parse(
      await db.rpc('group_get', { group_id: group.groupId }, owner.as),
    )
    expect(after.members.map((m) => m.handle)).toEqual(['owner', 'mod', 'member'])
    await db.sql.query(
      "update public.group_members set status = 'left', left_at = now() where human_id = $1",
      [suspended.humanId],
    )
  })

  it('group_update is for owners and moderators', async () => {
    await db.expectError(
      db.rpc('group_update', { group_id: group.groupId, name: 'X' }, member.as),
      'not_a_moderator',
    )
    await db.expectError(
      db.rpc('group_update', { group_id: group.groupId, name: 'X' }, outsider.as),
      'not_a_member',
    )
    const renamed = GroupDtoSchema.parse(
      await db.rpc('group_update', { group_id: group.groupId, name: 'Crew' }, mod.as),
    )
    expect(renamed.name).toBe('Crew')
    expect(
      GroupDtoSchema.parse(
        await db.rpc('group_update', { group_id: group.groupId, name: '' }, owner.as),
      ).name,
    ).toBeNull()
    expect(
      GroupDtoSchema.parse(
        await db.rpc('group_update', { group_id: group.groupId, name: 'Weekend Crew' }, owner.as),
      ).name,
    ).toBe('Weekend Crew')
    await db.expectError(
      db.rpc('group_update', { group_id: group.groupId, avatar_media_id: NIL }, owner.as),
      'invalid_input',
    )
  })

  describe('invites', () => {
    it('members get a default 30-day unlimited link; only owners/moderators set limits', async () => {
      const dto = GroupInviteCreateDtoSchema.parse(
        await db.rpc('group_invite_create', { group_id: group.groupId }, member.as),
      )
      expect(dto.url).toBe(`https://earth.social/g/${dto.token}`)
      expect(dto.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(dto.expiresAt).not.toBeNull()
      const days = (Date.parse(dto.expiresAt ?? '') - Date.now()) / 86_400_000
      expect(days).toBeGreaterThan(29.9)
      expect(days).toBeLessThan(30.1)
      expect(
        await scalar(
          db,
          'max_uses from public.group_invites where token_hash = earth.sha256_hex($1)',
          [dto.token],
        ),
      ).toBeNull()
      await db.expectError(
        db.rpc('group_invite_create', { group_id: group.groupId, max_uses: 3 }, member.as),
        'not_a_moderator',
      )
      await db.expectError(
        db.rpc('group_invite_create', { group_id: group.groupId }, outsider.as),
        'not_a_member',
      )
      await db.expectError(
        db.rpc('group_invite_create', { group_id: group.groupId, max_uses: 0 }, owner.as),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'group_invite_create',
          { group_id: group.groupId, expires_in_seconds: 31 * 86400 },
          owner.as,
        ),
        'invalid_input',
      )
      const limited = GroupInviteCreateDtoSchema.parse(
        await db.rpc(
          'group_invite_create',
          { group_id: group.groupId, expires_in_seconds: 0, max_uses: 5 },
          mod.as,
        ),
      )
      expect(limited.expiresAt).toBeNull()
      // The plaintext is never stored: only its sha256 hex.
      expect(await count(db, 'public.group_invites', 'token_hash = $1', [dto.token])).toBe(0)
      expect(
        await count(db, 'public.group_invites', 'token_hash = earth.sha256_hex($1)', [dto.token]),
      ).toBe(1)
    })

    it('group_invites_view exposes invites without the hash to creators and moderators only', async () => {
      const columns = await db.sql.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'group_invites_view' order by 1",
      )
      expect(columns.rows.map((r) => r.column_name)).not.toContain('token_hash')
      const visible = async (as: RoleSpec) =>
        (await db.asRole(as, (c) => c.query('select id from public.group_invites_view'))).rowCount
      expect(await visible(owner.as)).toBe(2)
      expect(await visible(mod.as)).toBe(2)
      expect(await visible(member.as)).toBe(1)
      expect(await visible(outsider.as)).toBe(0)
      expect(await visible(pending.as)).toBe(0)
      await expect(
        db.asRole('visitor', (c) => c.query('select id from public.group_invites_view')),
      ).rejects.toMatchObject({ code: '42501' })
      for (const as of ['visitor', guest.as, owner.as] as RoleSpec[]) {
        await expect(
          db.asRole(as, (c) => c.query('select token_hash from public.group_invites')),
        ).rejects.toMatchObject({ code: '42501' })
      }
    })

    it('preview exposes group name, member count and only public-profile members (never messages)', async () => {
      const limited = await createHuman(db, {
        handle: 'lim',
        displayName: 'Lim',
        visibility: 'limited',
      })
      const hidden = await createHuman(db, {
        handle: 'hid',
        displayName: 'Hid',
        visibility: 'hidden',
      })
      const blockedMember = await createHuman(db, { handle: 'blkm', displayName: 'Blocked' })
      await addMember(db, group, limited)
      await addMember(db, group, hidden)
      await addMember(db, group, blockedMember)
      const friendOfHidden = await createHuman(db, { handle: 'foh', displayName: 'Foh' })
      await befriend(db, friendOfHidden, hidden)
      await block(db, blockedMember, friendOfHidden)
      const token = (await createInvite(db, group, owner)).token

      await db.expectError(
        db.rpc('group_invite_preview', { token: 'nope' }, 'visitor'),
        'invite_invalid',
      )
      const visitorPreview = GroupInvitePreviewDtoSchema.parse(
        await db.rpc('group_invite_preview', { token }, 'visitor'),
      )
      expect(visitorPreview).toEqual({
        groupName: 'Weekend Crew',
        memberCount: 6,
        sampleMembers: [
          { displayName: 'Owner', avatarUrl: null },
          { displayName: 'Mod', avatarUrl: null },
          { displayName: 'Member', avatarUrl: null },
          { displayName: 'Blocked', avatarUrl: null },
        ],
        alreadyMember: false,
        expired: false,
      })
      expect(Object.keys(visitorPreview).sort()).toEqual([
        'alreadyMember',
        'expired',
        'groupName',
        'memberCount',
        'sampleMembers',
      ])
      expect(
        GroupInvitePreviewDtoSchema.parse(await db.rpc('group_invite_preview', { token }, guest.as))
          .sampleMembers,
      ).toHaveLength(4)
      // A Human viewer also sees friends with restricted profiles, never Humans across a block, never themself.
      const friendPreview = GroupInvitePreviewDtoSchema.parse(
        await db.rpc('group_invite_preview', { token }, friendOfHidden.as),
      )
      expect(friendPreview.sampleMembers.map((m) => m.displayName)).toEqual([
        'Owner',
        'Mod',
        'Member',
        'Hid',
      ])
      const memberPreview = GroupInvitePreviewDtoSchema.parse(
        await db.rpc('group_invite_preview', { token }, member.as),
      )
      expect(memberPreview.alreadyMember).toBe(true)
      expect(memberPreview.sampleMembers.map((m) => m.displayName)).not.toContain('Member')
      for (const h of [limited, hidden, blockedMember]) {
        await db.sql.query(
          "update public.group_members set status = 'left', left_at = now() where human_id = $1",
          [h.humanId],
        )
      }
    })

    it('join increments use_count, is a no-op for members, never creates friendship, refuses unusable links', async () => {
      const joiner = await createHuman(db, { handle: 'joiner' })
      const invite = await createInvite(db, group, owner, { maxUses: 2 })
      await db.expectError(
        db.rpc('group_invite_join', { token: invite.token }, 'visitor'),
        'not_authenticated',
      )
      await db.expectError(
        db.rpc('group_invite_join', { token: invite.token }, guest.as),
        'not_a_human',
      )
      await db.expectError(
        db.rpc('group_invite_join', { token: invite.token }, pending.as),
        'not_a_human',
      )
      await db.expectError(
        db.rpc('group_invite_join', { token: 'bogus' }, joiner.as),
        'invite_invalid',
      )

      const joined = GroupJoinDtoSchema.parse(
        await db.rpc('group_invite_join', { token: invite.token }, joiner.as),
      )
      expect(joined).toEqual({
        groupId: group.groupId,
        conversationId: group.conversationId,
        alreadyMember: false,
        isSecondGroup: false,
      })
      expect(
        await scalar(db, 'use_count from public.group_invites where id = $1', [invite.inviteId]),
      ).toBe(1)
      expect(
        await count(
          db,
          'public.group_members',
          "group_id = $1 and human_id = $2 and status = 'active' and role = 'member'",
          [group.groupId, joiner.humanId],
        ),
      ).toBe(1)
      expect(
        await count(db, 'public.conversation_members', 'conversation_id = $1 and human_id = $2', [
          group.conversationId,
          joiner.humanId,
        ]),
      ).toBe(1)
      expect(
        await count(db, 'public.relationships', 'source_human_id = $1 or target_human_id = $1', [
          joiner.humanId,
        ]),
      ).toBe(0)
      expect(
        await count(db, 'public.notifications', 'recipient_human_id = $1', [joiner.humanId]),
      ).toBe(0)

      // Same group through a second invite: alreadyMember, no use counted.
      const second = await createInvite(db, group, mod)
      expect(
        GroupJoinDtoSchema.parse(
          await db.rpc('group_invite_join', { token: second.token }, joiner.as),
        ).alreadyMember,
      ).toBe(true)
      expect(
        await scalar(db, 'use_count from public.group_invites where id = $1', [second.inviteId]),
      ).toBe(0)
      expect(
        await count(db, 'public.group_members', 'group_id = $1 and human_id = $2', [
          group.groupId,
          joiner.humanId,
        ]),
      ).toBe(1)

      // Exhaustion: the second use hits max_uses, the third joiner is refused.
      const other = await createHuman(db, { handle: 'other2' })
      const otherJoin = GroupJoinDtoSchema.parse(
        await db.rpc('group_invite_join', { token: invite.token }, other.as),
      )
      expect(otherJoin.alreadyMember).toBe(false)
      expect(
        await scalar(db, 'status from public.group_invites where id = $1', [invite.inviteId]),
      ).toBe('exhausted')
      const third = await createHuman(db, { handle: 'third' })
      await db.expectError(
        db.rpc('group_invite_join', { token: invite.token }, third.as),
        'invite_exhausted',
      )
      expect(
        GroupInvitePreviewDtoSchema.parse(
          await db.rpc('group_invite_preview', { token: invite.token }, 'visitor'),
        ).expired,
      ).toBe(true)

      // Expired by time.
      const expiring = await createInvite(db, group, owner, { expiresInSeconds: 60 })
      await db.sql.query(
        "update public.group_invites set expires_at = now() - interval '1 second' where id = $1",
        [expiring.inviteId],
      )
      await db.expectError(
        db.rpc('group_invite_join', { token: expiring.token }, third.as),
        'invite_expired',
      )
      expect(
        GroupInvitePreviewDtoSchema.parse(
          await db.rpc('group_invite_preview', { token: expiring.token }, third.as),
        ).expired,
      ).toBe(true)

      // Revoked: by a moderator or the creator, never by a plain member.
      const revocable = await createInvite(db, group, member)
      await db.expectError(
        db.rpc('group_invite_revoke', { invite_id: revocable.inviteId }, joiner.as),
        'not_a_moderator',
      )
      await db.expectError(
        db.rpc('group_invite_revoke', { invite_id: revocable.inviteId }, outsider.as),
        'not_a_member',
      )
      await db.expectError(
        db.rpc('group_invite_revoke', { invite_id: NIL }, owner.as),
        'invite_invalid',
      )
      expect(
        (
          await db.rpc<{ status: string }>(
            'group_invite_revoke',
            { invite_id: revocable.inviteId },
            member.as,
          )
        ).status,
      ).toBe('revoked')
      await db.expectError(
        db.rpc('group_invite_join', { token: revocable.token }, third.as),
        'invite_invalid',
      )
      expect(
        GroupInvitePreviewDtoSchema.parse(
          await db.rpc('group_invite_preview', { token: revocable.token }, 'visitor'),
        ).expired,
      ).toBe(true)
      expect(await count(db, 'private.audit_log', "action = 'group_invite_revoke'")).toBe(1)

      // isSecondGroup reports an existing membership elsewhere; a left member may rejoin, a removed one may not.
      const otherGroup = await createGroup(db, third, 'Other')
      const otherInvite = await createInvite(db, otherGroup, third)
      expect(
        GroupJoinDtoSchema.parse(
          await db.rpc('group_invite_join', { token: otherInvite.token }, joiner.as),
        ).isSecondGroup,
      ).toBe(true)
      await db.rpc('group_leave', { group_id: otherGroup.groupId }, joiner.as)
      expect(
        GroupJoinDtoSchema.parse(
          await db.rpc('group_invite_join', { token: otherInvite.token }, joiner.as),
        ).alreadyMember,
      ).toBe(false)
      await db.rpc(
        'group_member_remove',
        { group_id: otherGroup.groupId, human_id: joiner.humanId },
        third.as,
      )
      await db.expectError(
        db.rpc('group_invite_join', { token: otherInvite.token }, joiner.as),
        'join_not_allowed',
      )
      expect(
        await scalar(db, 'member_count from public.groups where id = $1', [otherGroup.groupId]),
      ).toBe(1)
    })

    it('join rate limit: 10 per 10 minutes', async () => {
      const busy = await createHuman(db, { handle: 'busy' })
      const invite = await createInvite(db, group, owner)
      for (let i = 0; i < 10; i += 1)
        await db.rpc('group_invite_join', { token: invite.token }, busy.as)
      await db.expectError(
        db.rpc('group_invite_join', { token: invite.token }, busy.as),
        'rate_limited',
      )
    })
  })

  describe('membership changes', () => {
    it('member removal and role changes follow the owner > moderator > member ladder', async () => {
      const g = await createGroup(db, owner, 'Ladder')
      await addMember(db, g, mod, 'moderator')
      await addMember(db, g, member)
      const second = await createHuman(db, { handle: 'second' })
      await addMember(db, g, second)

      await db.expectError(
        db.rpc('group_member_remove', { group_id: g.groupId, human_id: second.humanId }, member.as),
        'not_a_moderator',
      )
      await db.expectError(
        db.rpc(
          'group_member_remove',
          { group_id: g.groupId, human_id: second.humanId },
          outsider.as,
        ),
        'not_a_member',
      )
      await db.expectError(
        db.rpc('group_member_remove', { group_id: g.groupId, human_id: owner.humanId }, mod.as),
        'forbidden',
      )
      await db.expectError(
        db.rpc('group_member_remove', { group_id: g.groupId, human_id: mod.humanId }, mod.as),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'group_member_remove',
          { group_id: g.groupId, human_id: outsider.humanId },
          owner.as,
        ),
        'not_a_member',
      )

      await db.expectError(
        db.rpc(
          'group_member_set_role',
          { group_id: g.groupId, human_id: second.humanId, role: 'moderator' },
          member.as,
        ),
        'not_a_moderator',
      )
      await db.expectError(
        db.rpc(
          'group_member_set_role',
          { group_id: g.groupId, human_id: second.humanId, role: 'moderator' },
          mod.as,
        ),
        'forbidden',
      )
      await db.expectError(
        db.rpc(
          'group_member_set_role',
          { group_id: g.groupId, human_id: second.humanId, role: 'owner' },
          owner.as,
        ),
        'invalid_input',
      )
      const promoted = GroupMemberDtoSchema.parse(
        await db.rpc(
          'group_member_set_role',
          { group_id: g.groupId, human_id: second.humanId, role: 'moderator' },
          owner.as,
        ),
      )
      expect(promoted).toMatchObject({
        humanId: second.humanId,
        role: 'moderator',
        status: 'active',
      })
      await db.expectError(
        db.rpc('group_member_remove', { group_id: g.groupId, human_id: second.humanId }, mod.as),
        'forbidden',
      )
      expect(
        GroupMemberDtoSchema.parse(
          await db.rpc(
            'group_member_set_role',
            { group_id: g.groupId, human_id: second.humanId, role: 'member' },
            owner.as,
          ),
        ).role,
      ).toBe('member')

      const removed = await db.rpc<{ status: string }>(
        'group_member_remove',
        { group_id: g.groupId, human_id: second.humanId },
        mod.as,
      )
      expect(removed.status).toBe('removed')
      expect(
        await scalar(
          db,
          'removed_by_human_id from public.group_members where group_id = $1 and human_id = $2',
          [g.groupId, second.humanId],
        ),
      ).toBe(mod.humanId)
      expect(
        await count(db, 'public.conversation_members', 'conversation_id = $1 and human_id = $2', [
          g.conversationId,
          second.humanId,
        ]),
      ).toBe(0)
      expect(await scalar(db, 'member_count from public.groups where id = $1', [g.groupId])).toBe(3)
      expect(
        await count(
          db,
          'private.audit_log',
          "action in ('group_member_remove', 'group_member_set_role') and target_id = $1",
          [g.groupId],
        ),
      ).toBe(3)
      await db.expectError(db.rpc('group_get', { group_id: g.groupId }, second.as), 'not_a_member')
    })

    it('owner leaving transfers ownership (earliest moderator, else earliest member); the last one archives', async () => {
      const g = await createGroup(db, owner, 'Transfer')
      const first = await createHuman(db, { handle: 'first' })
      const later = await createHuman(db, { handle: 'later' })
      await addMember(db, g, first)
      await db.sql.query(
        "update public.group_members set joined_at = now() - interval '1 hour' where group_id = $1 and human_id = $2",
        [g.groupId, first.humanId],
      )
      await addMember(db, g, later, 'moderator')

      await db.expectError(
        db.rpc('group_leave', { group_id: g.groupId }, outsider.as),
        'not_a_member',
      )
      const left = await db.rpc<{ newOwnerHumanId: string | null; archived: boolean }>(
        'group_leave',
        { group_id: g.groupId },
        owner.as,
      )
      expect(left).toMatchObject({ newOwnerHumanId: later.humanId, archived: false })
      expect(
        await scalar(
          db,
          'role::text from public.group_members where group_id = $1 and human_id = $2',
          [g.groupId, later.humanId],
        ),
      ).toBe('owner')
      expect(
        await scalar(
          db,
          "status::text || ':' || role::text from public.group_members where group_id = $1 and human_id = $2",
          [g.groupId, owner.humanId],
        ),
      ).toBe('left:member')
      expect(
        await count(db, 'public.conversation_members', 'conversation_id = $1 and human_id = $2', [
          g.conversationId,
          owner.humanId,
        ]),
      ).toBe(0)
      await db.expectError(db.rpc('group_get', { group_id: g.groupId }, owner.as), 'not_a_member')

      const second = await db.rpc<{ newOwnerHumanId: string | null }>(
        'group_leave',
        { group_id: g.groupId },
        later.as,
      )
      expect(second.newOwnerHumanId).toBe(first.humanId)
      const last = await db.rpc<{ newOwnerHumanId: string | null; archived: boolean }>(
        'group_leave',
        { group_id: g.groupId },
        first.as,
      )
      expect(last).toMatchObject({ newOwnerHumanId: null, archived: true })
      expect(await scalar(db, 'status from public.groups where id = $1', [g.groupId])).toBe(
        'archived',
      )
      expect(await scalar(db, 'member_count from public.groups where id = $1', [g.groupId])).toBe(0)
    })
  })

  it('RLS: groups and memberships are visible to active members only; no client writes', async () => {
    expect(
      (
        await db.asRole(member.as, (c) =>
          c.query('select id from public.groups where id = $1', [group.groupId]),
        )
      ).rowCount,
    ).toBe(1)
    expect(
      (
        await db.asRole(outsider.as, (c) =>
          c.query('select id from public.groups where id = $1', [group.groupId]),
        )
      ).rowCount,
    ).toBe(0)
    expect(
      (await db.asRole(pending.as, (c) => c.query('select id from public.groups'))).rowCount,
    ).toBe(0)
    expect(
      (await db.asRole(guest.as, (c) => c.query('select id from public.groups'))).rowCount,
    ).toBe(0)
    expect(
      (
        await db.asRole(outsider.as, (c) =>
          c.query('select * from public.group_members where group_id = $1', [group.groupId]),
        )
      ).rowCount,
    ).toBe(0)
    expect(
      (
        await db.asRole(member.as, (c) =>
          c.query("select * from public.group_members where group_id = $1 and status = 'active'", [
            group.groupId,
          ]),
        )
      ).rowCount,
    ).toBeGreaterThanOrEqual(3)
    await expect(
      db.asRole('visitor', (c) => c.query('select id from public.groups')),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      db.asRole(owner.as, (c) =>
        c.query("update public.groups set name = 'hack' where id = $1", [group.groupId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      db.asRole(owner.as, (c) =>
        c.query('insert into public.group_members (group_id, human_id) values ($1, $2)', [
          group.groupId,
          outsider.humanId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})
