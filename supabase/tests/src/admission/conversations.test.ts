import {
  ConversationDetailDtoSchema,
  ConversationSummaryDtoSchema,
  ConversationsListDtoSchema,
} from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import { block, count, createGroup, createGuest, createHuman, scalar, type Human } from './fixtures'

const NIL = '00000000-0000-0000-0000-000000000000'

describe('conversations (spec §25–26; DB_API §2 membership RPCs)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human
  let dave: Human
  let pending: Human

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    carol = await createHuman(db, { handle: 'carol', displayName: 'Carol' })
    dave = await createHuman(db, { handle: 'dave', displayName: 'Dave' })
    pending = await createHuman(db, { handle: 'pend', status: 'pending' })
  })

  afterAll(async () => {
    await db.drop()
  })

  it('conversation_direct_get_or_create is idempotent in either order and refuses blocks', async () => {
    const guest = await createGuest(db)
    await db.expectError(
      db.rpc('conversation_direct_get_or_create', { other_human_id: bob.humanId }, 'visitor'),
      'not_authenticated',
    )
    await db.expectError(
      db.rpc('conversation_direct_get_or_create', { other_human_id: bob.humanId }, guest.as),
      'not_a_human',
    )
    await db.expectError(
      db.rpc('conversation_direct_get_or_create', { other_human_id: bob.humanId }, pending.as),
      'not_a_human',
    )
    await db.expectError(
      db.rpc('conversation_direct_get_or_create', { other_human_id: alice.humanId }, alice.as),
      'invalid_input',
    )
    await db.expectError(
      db.rpc('conversation_direct_get_or_create', { other_human_id: pending.humanId }, alice.as),
      'not_visible',
    )
    await db.expectError(
      db.rpc('conversation_direct_get_or_create', { other_human_id: NIL }, alice.as),
      'not_visible',
    )

    const fromAlice = ConversationSummaryDtoSchema.parse(
      await db.rpc('conversation_direct_get_or_create', { other_human_id: bob.humanId }, alice.as),
    )
    expect(fromAlice).toMatchObject({
      type: 'direct',
      groupId: null,
      title: 'Bob',
      avatarUrls: [],
      lastMessage: null,
      unreadCount: 0,
      activeRoom: null,
      lastMessageAt: null,
    })
    const fromBob = ConversationSummaryDtoSchema.parse(
      await db.rpc('conversation_direct_get_or_create', { other_human_id: alice.humanId }, bob.as),
    )
    expect(fromBob.id).toBe(fromAlice.id)
    expect(fromBob.title).toBe('Alice')
    const again = ConversationSummaryDtoSchema.parse(
      await db.rpc('conversation_direct_get_or_create', { other_human_id: bob.humanId }, alice.as),
    )
    expect(again.id).toBe(fromAlice.id)
    expect(await count(db, 'public.conversations', "type = 'direct'")).toBe(1)
    expect(
      await count(db, 'public.conversation_members', 'conversation_id = $1', [fromAlice.id]),
    ).toBe(2)
    expect(
      await scalar(db, 'direct_key from public.conversations where id = $1', [fromAlice.id]),
    ).toBe([alice.humanId, bob.humanId].sort().join(':'))

    await block(db, carol, alice)
    await db.expectError(
      db.rpc('conversation_direct_get_or_create', { other_human_id: carol.humanId }, alice.as),
      'blocked',
    )
    await db.expectError(
      db.rpc('conversation_direct_get_or_create', { other_human_id: alice.humanId }, carol.as),
      'blocked',
    )
  })

  it('conversation_group_create needs two or more other active Humans and makes a temporary group', async () => {
    await db.expectError(
      db.rpc('conversation_group_create', { human_ids: [bob.humanId] }, alice.as),
      'invalid_input',
    )
    await db.expectError(
      db.rpc(
        'conversation_group_create',
        { human_ids: [bob.humanId, bob.humanId, alice.humanId] },
        alice.as,
      ),
      'invalid_input',
    )
    await db.expectError(
      db.rpc('conversation_group_create', { human_ids: [bob.humanId, pending.humanId] }, alice.as),
      'not_visible',
    )
    await db.expectError(
      db.rpc('conversation_group_create', { human_ids: [bob.humanId, carol.humanId] }, alice.as),
      'blocked',
    )
    const summary = ConversationSummaryDtoSchema.parse(
      await db.rpc(
        'conversation_group_create',
        { human_ids: [bob.humanId, dave.humanId] },
        alice.as,
      ),
    )
    expect(summary.type).toBe('group')
    expect(summary.title).toBe('Bob + Dave')
    expect(summary.groupId).not.toBeNull()
    expect(
      await scalar(
        db,
        "kind::text || ':' || coalesce(name, '<null>') from public.groups where id = $1",
        [summary.groupId],
      ),
    ).toBe('temporary:<null>')
    expect(
      await scalar(db, 'member_count from public.groups where id = $1', [summary.groupId]),
    ).toBe(3)
    expect(
      await count(db, 'public.conversation_members', 'conversation_id = $1', [summary.id]),
    ).toBe(3)
    expect(
      await scalar(
        db,
        'role::text from public.group_members where group_id = $1 and human_id = $2',
        [summary.groupId, alice.humanId],
      ),
    ).toBe('owner')
    // Bob sees the other two in the title.
    const bobView = ConversationDetailDtoSchema.parse(
      await db.rpc('conversation_get', { conversation_id: summary.id }, bob.as),
    )
    expect(bobView.title).toBe('Alice + Dave')
    // Titles follow the naming rule: "A, B, C + N".
    const many = [
      bob,
      dave,
      await createHuman(db, { handle: 'erin', displayName: 'Erin' }),
      await createHuman(db, { handle: 'finn', displayName: 'Finn' }),
    ]
    const big = ConversationSummaryDtoSchema.parse(
      await db.rpc(
        'conversation_group_create',
        { human_ids: many.map((h) => h.humanId) },
        alice.as,
      ),
    )
    expect(big.title).toBe('Bob, Dave, Erin + 1')
  })

  it('conversations_list orders by activity, paginates with a cursor and hides blocked DMs', async () => {
    const list = ConversationsListDtoSchema.parse(await db.rpc('conversations_list', {}, alice.as))
    expect(list.conversations.length).toBe(3)
    const ids = list.conversations.map((c) => c.id)
    // Newest activity first: the last created group chat comes first.
    const created = await db.sql.query<{ id: string }>(
      `select c.id from public.conversations c join public.conversation_members cm on cm.conversation_id = c.id and cm.human_id = $1
        order by coalesce(c.last_message_at, c.created_at) desc, c.id`,
      [alice.humanId],
    )
    expect(ids).toEqual(created.rows.map((r) => r.id))
    for (const c of list.conversations)
      expect(c).toMatchObject({ lastMessage: null, unreadCount: 0, activeRoom: null })

    // A bumped last_message_at moves a conversation to the top.
    const dm = ids[ids.length - 1] ?? ''
    await db.sql.query('update public.conversations set last_message_at = now() where id = $1', [
      dm,
    ])
    const bumped = ConversationsListDtoSchema.parse(
      await db.rpc('conversations_list', {}, alice.as),
    )
    expect(bumped.conversations[0]?.id).toBe(dm)
    expect(bumped.conversations[0]?.lastMessageAt).not.toBeNull()

    // Cursor pagination.
    const page1 = await db.rpc<{ conversations: Array<{ id: string }>; nextCursor: string | null }>(
      'conversations_list',
      { limit: 2 },
      alice.as,
    )
    expect(page1.conversations).toHaveLength(2)
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await db.rpc<{ conversations: Array<{ id: string }>; nextCursor: string | null }>(
      'conversations_list',
      { cursor: page1.nextCursor, limit: 2 },
      alice.as,
    )
    expect(page2.conversations).toHaveLength(1)
    expect(page2.nextCursor).toBeNull()
    expect(new Set([...page1.conversations, ...page2.conversations].map((c) => c.id)).size).toBe(3)

    // A DM with a Human blocked either way is not listed.
    await block(db, bob, alice)
    const filtered = ConversationsListDtoSchema.parse(
      await db.rpc('conversations_list', {}, alice.as),
    )
    expect(filtered.conversations.map((c) => c.id)).not.toContain(dm)
    await db.expectError(db.rpc('conversation_get', { conversation_id: dm }, alice.as), 'blocked')
    await db.sql.query('delete from public.blocks where blocker_human_id = $1', [bob.humanId])

    await db.expectError(db.rpc('conversations_list', {}, 'visitor'), 'not_authenticated')
    await db.expectError(db.rpc('conversations_list', {}, pending.as), 'not_a_human')
    expect(
      ConversationsListDtoSchema.parse(await db.rpc('conversations_list', {}, carol.as))
        .conversations,
    ).toEqual([])
  })

  it('conversation_get returns the summary plus members for members only', async () => {
    const dm = ConversationSummaryDtoSchema.parse(
      await db.rpc('conversation_direct_get_or_create', { other_human_id: bob.humanId }, alice.as),
    )
    const detail = ConversationDetailDtoSchema.parse(
      await db.rpc('conversation_get', { conversation_id: dm.id }, alice.as),
    )
    expect(detail.id).toBe(dm.id)
    expect(detail.members.map((m) => [m.handle, m.lastReadMessageId])).toEqual([
      ['alice', null],
      ['bob', null],
    ])
    await db.expectError(
      db.rpc('conversation_get', { conversation_id: dm.id }, carol.as),
      'conversation_not_found',
    )
    await db.expectError(
      db.rpc('conversation_get', { conversation_id: NIL }, alice.as),
      'conversation_not_found',
    )
    await db.expectError(
      db.rpc('conversation_get', { conversation_id: dm.id }, 'visitor'),
      'not_authenticated',
    )
  })

  it('preferences and read receipts', async () => {
    const dm = ConversationSummaryDtoSchema.parse(
      await db.rpc('conversation_direct_get_or_create', { other_human_id: bob.humanId }, alice.as),
    )
    await db.expectError(
      db.rpc('conversation_set_prefs', { conversation_id: dm.id, mute_state: 'loud' }, alice.as),
      'invalid_input',
    )
    await db.expectError(
      db.rpc(
        'conversation_set_prefs',
        { conversation_id: dm.id, notification_level: 'x' },
        alice.as,
      ),
      'invalid_input',
    )
    await db.expectError(
      db.rpc('conversation_set_prefs', { conversation_id: dm.id, mute_state: 'muted' }, carol.as),
      'conversation_not_found',
    )
    expect(
      await db.rpc(
        'conversation_set_prefs',
        { conversation_id: dm.id, mute_state: 'muted' },
        alice.as,
      ),
    ).toEqual({
      conversationId: dm.id,
      muteState: 'muted',
      notificationLevel: 'all',
    })
    expect(
      await db.rpc(
        'conversation_set_prefs',
        { conversation_id: dm.id, notification_level: 'mentions' },
        alice.as,
      ),
    ).toEqual({
      conversationId: dm.id,
      muteState: 'muted',
      notificationLevel: 'mentions',
    })
    const receipts = await db.rpc<Array<{ humanId: string; lastReadMessageId: string | null }>>(
      'conversation_read_receipts',
      { conversation_id: dm.id },
      bob.as,
    )
    expect(receipts.map((r) => r.humanId).sort()).toEqual([alice.humanId, bob.humanId].sort())
    await db.expectError(
      db.rpc('conversation_read_receipts', { conversation_id: dm.id }, carol.as),
      'conversation_not_found',
    )
  })

  it('RLS: members read; own preferences are directly editable; nothing else is writable', async () => {
    const dm = ConversationSummaryDtoSchema.parse(
      await db.rpc('conversation_direct_get_or_create', { other_human_id: bob.humanId }, alice.as),
    )
    expect(
      (
        await db.asRole(alice.as, (c) =>
          c.query('select id from public.conversations where id = $1', [dm.id]),
        )
      ).rowCount,
    ).toBe(1)
    expect(
      (
        await db.asRole(carol.as, (c) =>
          c.query('select id from public.conversations where id = $1', [dm.id]),
        )
      ).rowCount,
    ).toBe(0)
    expect(
      (
        await db.asRole(bob.as, (c) =>
          c.query('select human_id from public.conversation_members where conversation_id = $1', [
            dm.id,
          ]),
        )
      ).rowCount,
    ).toBe(2)
    expect(
      (
        await db.asRole(carol.as, (c) =>
          c.query('select human_id from public.conversation_members where conversation_id = $1', [
            dm.id,
          ]),
        )
      ).rowCount,
    ).toBe(0)
    const own = await db.asRole(bob.as, (c) =>
      c.query(
        "update public.conversation_members set mute_state = 'muted' where conversation_id = $1",
        [dm.id],
      ),
    )
    expect(own.rowCount).toBe(1)
    expect(
      await scalar(
        db,
        'mute_state from public.conversation_members where conversation_id = $1 and human_id = $2',
        [dm.id, bob.humanId],
      ),
    ).toBe('muted')
    expect(
      await scalar(
        db,
        'mute_state from public.conversation_members where conversation_id = $1 and human_id = $2',
        [dm.id, alice.humanId],
      ),
    ).toBe('muted')
    await expect(
      db.asRole(bob.as, (c) =>
        c.query(
          'update public.conversation_members set unread_count = 9 where conversation_id = $1',
          [dm.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      db.asRole(bob.as, (c) =>
        c.query("insert into public.conversations (type, direct_key) values ('direct', 'a:b')"),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      db.asRole(bob.as, (c) => c.query('delete from public.conversation_members')),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      db.asRole('visitor', (c) => c.query('select id from public.conversations')),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('every group has exactly one canonical conversation', async () => {
    const g = await createGroup(db, alice, 'Only')
    await expect(
      db.sql.query("insert into public.conversations (type, group_id) values ('group', $1)", [
        g.groupId,
      ]),
    ).rejects.toMatchObject({ code: '23505' })
    await expect(
      db.sql.query("insert into public.conversations (type, direct_key) values ('group', 'x')"),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
