/**
 * Messaging RPC invariants (spec §53–56, §83, §108; DB_API §2; 0250–0270): idempotent sends,
 * server-timestamp ordering with keyset pages, membership and block enforcement, unread state,
 * tombstones that keep threads intact, reactions and the 60/min send limit.
 */
import { MessageDtoSchema, MessagesPageDtoSchema, type MessagesPageDto } from '@earth/domain'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addMember,
  block,
  count,
  createGroup,
  createGuest,
  createHuman,
  scalar,
  type Human,
} from '../admission/fixtures'
import { createTestDb, type RoleSpec, type TestDb } from '../harness'

const NIL = '00000000-0000-0000-0000-000000000000'
const UNIQUE_VIOLATION = '23505'
const PERMISSION_DENIED = '42501'

describe('messages (spec §53–56; DB_API §2)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human
  let pending: Human
  let guest: { userId: string; as: RoleSpec }

  const send = (
    as: RoleSpec,
    conversationId: string,
    text: string | null,
    extra: Record<string, unknown> = {},
  ) =>
    db.rpc<Record<string, unknown>>(
      'message_send',
      { conversation_id: conversationId, client_id: randomUUID(), type: 'text', text, ...extra },
      as,
    )

  const sent = async (
    as: RoleSpec,
    conversationId: string,
    text: string | null,
    extra: Record<string, unknown> = {},
  ) => MessageDtoSchema.parse(await send(as, conversationId, text, extra))

  const dmBetween = async (a: Human, b: Human): Promise<string> =>
    (
      await db.rpc<{ id: string }>(
        'conversation_direct_get_or_create',
        { other_human_id: b.humanId },
        a.as,
      )
    ).id

  const unreadOf = (conversationId: string, human: Human) =>
    scalar<number>(
      db,
      'unread_count from public.conversation_members where conversation_id = $1 and human_id = $2',
      [conversationId, human.humanId],
    )

  const page = async (
    as: RoleSpec,
    conversationId: string,
    beforeId: string | null,
    limit: number,
  ): Promise<MessagesPageDto> =>
    MessagesPageDtoSchema.parse(
      await db.rpc(
        'messages_list',
        { conversation_id: conversationId, before_id: beforeId, limit },
        as,
      ),
    )

  const react = async (as: RoleSpec, messageId: string, reaction: string) =>
    MessageDtoSchema.parse(
      await db.rpc('message_reaction_toggle', { message_id: messageId, reaction }, as),
    )

  let fresh = 0
  const newHuman = async (prefix: string): Promise<Human> => {
    fresh += 1
    return createHuman(db, { handle: `${prefix}${fresh}`, displayName: `${prefix} ${fresh}` })
  }

  const visibleRows = (as: RoleSpec, conversationId: string) =>
    db
      .asRole(as, (c) =>
        c.query('select id from public.messages where conversation_id = $1', [conversationId]),
      )
      .then((r) => r.rowCount ?? 0)

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    carol = await createHuman(db, { handle: 'carol', displayName: 'Carol' })
    pending = await createHuman(db, { handle: 'pend', status: 'pending' })
    guest = await createGuest(db)
  })

  beforeEach(async () => {
    // Every test starts with a full send budget (the file shares one scratch database).
    await db.sql.query('delete from private.rate_limits')
  })

  afterAll(async () => {
    await db.drop()
  })

  it('message_send is idempotent on client_id and validates its input', async () => {
    const dm = await dmBetween(alice, bob)
    const clientId = randomUUID()
    const first = MessageDtoSchema.parse(
      await db.rpc(
        'message_send',
        { conversation_id: dm, client_id: clientId, type: 'text', text: 'hello bob' },
        alice.as,
      ),
    )
    expect(first).toMatchObject({
      conversationId: dm,
      senderHumanId: alice.humanId,
      type: 'text',
      text: 'hello bob',
      payload: {},
      replyToMessageId: null,
      editedAt: null,
      deletedAt: null,
      clientId,
      reactions: [],
    })
    // The retry returns the row it already created, whatever it carries now (spec §53, §108).
    const retry = MessageDtoSchema.parse(
      await db.rpc(
        'message_send',
        { conversation_id: dm, client_id: clientId, type: 'text', text: 'hello bob (retry)' },
        alice.as,
      ),
    )
    expect(retry.id).toBe(first.id)
    expect(retry.text).toBe('hello bob')
    expect(await count(db, 'public.messages', 'conversation_id = $1', [dm])).toBe(1)
    // The same client id from another sender is a different message.
    const bobs = MessageDtoSchema.parse(
      await db.rpc(
        'message_send',
        { conversation_id: dm, client_id: clientId, type: 'text', text: 'hi' },
        bob.as,
      ),
    )
    expect(bobs.id).not.toBe(first.id)
    expect(bobs.clientId).toBe(clientId)
    // A new client id is a new message; text is trimmed.
    const second = await sent(alice.as, dm, '  second  ')
    expect(second.id).not.toBe(first.id)
    expect(second.text).toBe('second')
    // Media messages need no text; the payload is kept.
    const image = await sent(alice.as, dm, null, {
      type: 'image',
      payload: { mediaId: NIL, width: 10 },
    })
    expect(image.type).toBe('image')
    expect(image.text).toBeNull()
    expect(image.payload).toEqual({ mediaId: NIL, width: 10 })
    // Replies must point into the same conversation.
    const reply = await sent(alice.as, dm, 'reply', { reply_to_message_id: first.id })
    expect(reply.replyToMessageId).toBe(first.id)

    await db.expectError(send(alice.as, dm, 'x', { client_id: null }), 'invalid_input')
    await db.expectError(send(alice.as, dm, 'x', { type: 'system' }), 'invalid_input')
    await db.expectError(send(alice.as, dm, '   '), 'invalid_input')
    await db.expectError(send(alice.as, dm, null), 'invalid_input')
    await db.expectError(send(alice.as, dm, 'x'.repeat(4001)), 'invalid_input')
    await db.expectError(send(alice.as, dm, 'x', { payload: '[1, 2]' }), 'invalid_input')
    await db.expectError(send(alice.as, dm, 'x', { reply_to_message_id: NIL }), 'message_not_found')
    const other = await dmBetween(alice, carol)
    const elsewhere = await sent(alice.as, other, 'elsewhere')
    await db.expectError(
      send(alice.as, dm, 'x', { reply_to_message_id: elsewhere.id }),
      'message_not_found',
    )
    await db.expectError(send(alice.as, NIL, 'x'), 'conversation_not_found')
    await db.expectError(send('visitor', dm, 'x'), 'not_authenticated')
    await db.expectError(send(guest.as, dm, 'x'), 'not_a_human')
    await db.expectError(send(pending.as, dm, 'x'), 'not_a_human')
  })

  it('orders by server timestamp (id as tiebreaker) and pages 120 messages in 3 pages without duplicates or gaps', async () => {
    const group = await createGroup(db, alice, 'Pages')
    await addMember(db, group, bob)
    // 120 rows, four per timestamp so the id tiebreaker matters; inserted out of order.
    await db.sql.query(
      `insert into public.messages (conversation_id, sender_human_id, type, text, client_id, created_at)
       select $1, case when i % 2 = 0 then $2::uuid else $3::uuid end, 'text', 'm' || i, gen_random_uuid(),
              '2030-01-01T00:00:00Z'::timestamptz + make_interval(secs => (i / 4))
         from generate_series(1, 120) as i
        order by random()`,
      [group.conversationId, alice.humanId, bob.humanId],
    )
    const expected = (
      await db.sql.query<{ id: string }>(
        `select id from public.messages where conversation_id = $1 order by created_at desc, id desc`,
        [group.conversationId],
      )
    ).rows.map((r) => r.id)
    expect(expected).toHaveLength(120)

    const page1 = await page(bob.as, group.conversationId, null, 50)
    expect(page1.messages).toHaveLength(50)
    expect(page1.nextCursor).toBe(page1.messages[49]?.id)
    const page2 = await page(bob.as, group.conversationId, page1.nextCursor, 50)
    expect(page2.messages).toHaveLength(50)
    expect(page2.nextCursor).toBe(page2.messages[49]?.id)
    const page3 = await page(bob.as, group.conversationId, page2.nextCursor, 50)
    expect(page3.messages).toHaveLength(20)
    expect(page3.nextCursor).toBeNull()

    const walked = [...page1.messages, ...page2.messages, ...page3.messages]
    expect(new Set(walked.map((m) => m.id)).size).toBe(120)
    expect(walked.map((m) => m.id)).toEqual(expected)
    for (let i = 1; i < walked.length; i += 1) {
      const prev = walked[i - 1]
      const cur = walked[i]
      if (prev === undefined || cur === undefined) throw new Error('unreachable')
      expect(Date.parse(prev.createdAt) >= Date.parse(cur.createdAt)).toBe(true)
    }
    // The limit is clamped to 200; an exact fit has no next cursor.
    const all = await page(alice.as, group.conversationId, null, 500)
    expect(all.messages).toHaveLength(120)
    expect(all.nextCursor).toBeNull()
    const exact = await page(alice.as, group.conversationId, null, 120)
    expect(exact.messages).toHaveLength(120)
    expect(exact.nextCursor).toBeNull()
    // Cursors from another conversation are refused.
    const dm = await dmBetween(alice, bob)
    const dmMessage = await sent(alice.as, dm, 'dm')
    await db.expectError(
      db.rpc(
        'messages_list',
        { conversation_id: group.conversationId, before_id: dmMessage.id },
        alice.as,
      ),
      'message_not_found',
    )
    await db.expectError(
      db.rpc('messages_list', { conversation_id: group.conversationId }, 'visitor'),
      'not_authenticated',
    )
    await db.expectError(
      db.rpc('messages_list', { conversation_id: group.conversationId }, guest.as),
      'not_a_human',
    )
    await db.expectError(
      db.rpc('messages_list', { conversation_id: group.conversationId }, pending.as),
      'not_a_human',
    )
  })

  it('messages_since walks forward from an id, 200 at a time, and returns the newest 200 without one', async () => {
    const group = await createGroup(db, alice, 'Since')
    await addMember(db, group, bob)
    await db.sql.query(
      `insert into public.messages (conversation_id, sender_human_id, type, text, client_id, created_at)
       select $1, $2, 'text', 's' || i, gen_random_uuid(),
              '2030-02-01T00:00:00Z'::timestamptz + make_interval(secs => (i / 3))
         from generate_series(1, 230) as i`,
      [group.conversationId, alice.humanId],
    )
    const ascending = (
      await db.sql.query<{ id: string }>(
        `select id from public.messages where conversation_id = $1 order by created_at, id`,
        [group.conversationId],
      )
    ).rows.map((r) => r.id)
    const oldest = ascending[0] ?? ''

    const first = MessagesPageDtoSchema.parse(
      await db.rpc(
        'messages_since',
        { conversation_id: group.conversationId, after_id: oldest },
        bob.as,
      ),
    )
    expect(first.messages).toHaveLength(200)
    expect(first.messages.map((m) => m.id)).toEqual(ascending.slice(1, 201))
    expect(first.nextCursor).toBe(ascending[200])
    const rest = MessagesPageDtoSchema.parse(
      await db.rpc(
        'messages_since',
        { conversation_id: group.conversationId, after_id: first.nextCursor },
        bob.as,
      ),
    )
    expect(rest.messages.map((m) => m.id)).toEqual(ascending.slice(201))
    expect(rest.nextCursor).toBeNull()
    const nothing = MessagesPageDtoSchema.parse(
      await db.rpc(
        'messages_since',
        { conversation_id: group.conversationId, after_id: ascending[229] },
        bob.as,
      ),
    )
    expect(nothing.messages).toEqual([])

    const tail = MessagesPageDtoSchema.parse(
      await db.rpc('messages_since', { conversation_id: group.conversationId }, bob.as),
    )
    expect(tail.messages.map((m) => m.id)).toEqual(ascending.slice(30))
    expect(tail.nextCursor).toBeNull()
    await db.expectError(
      db.rpc('messages_since', { conversation_id: group.conversationId, after_id: NIL }, bob.as),
      'message_not_found',
    )
    await db.expectError(
      db.rpc('messages_since', { conversation_id: group.conversationId }, 'visitor'),
      'not_authenticated',
    )
  })

  it('non-members cannot send, read, react, edit, delete or mark read; leaving a group ends access', async () => {
    const pat = await newHuman('pat')
    const quinn = await newHuman('quinn')
    const dm = await dmBetween(pat, quinn)
    const message = await sent(pat.as, dm, 'private')
    await db.expectError(send(carol.as, dm, 'intruder'), 'conversation_not_found')
    await db.expectError(
      db.rpc('messages_list', { conversation_id: dm }, carol.as),
      'conversation_not_found',
    )
    await db.expectError(
      db.rpc('messages_since', { conversation_id: dm }, carol.as),
      'conversation_not_found',
    )
    await db.expectError(
      db.rpc('conversation_mark_read', { conversation_id: dm }, carol.as),
      'conversation_not_found',
    )
    await db.expectError(
      db.rpc('message_edit', { message_id: message.id, text: 'x' }, carol.as),
      'message_not_found',
    )
    await db.expectError(
      db.rpc('message_delete', { message_id: message.id }, carol.as),
      'message_not_found',
    )
    await db.expectError(
      db.rpc('message_reaction_toggle', { message_id: message.id, reaction: '👍' }, carol.as),
      'message_not_found',
    )
    expect(await visibleRows(carol.as, dm)).toBe(0)
    expect(await visibleRows(quinn.as, dm)).toBe(1)
    expect(await count(db, 'public.messages', 'conversation_id = $1', [dm])).toBe(1)

    const group = await createGroup(db, alice, 'Leavers')
    await addMember(db, group, carol)
    await sent(carol.as, group.conversationId, 'while a member')
    await db.rpc('group_leave', { group_id: group.groupId }, carol.as)
    await db.expectError(
      send(carol.as, group.conversationId, 'after leaving'),
      'conversation_not_found',
    )
    await db.expectError(
      db.rpc('messages_list', { conversation_id: group.conversationId }, carol.as),
      'conversation_not_found',
    )
    expect(await visibleRows(carol.as, group.conversationId)).toBe(0)
  })

  it('a blocked pair cannot DM but both still read and write a shared group conversation', async () => {
    const alice = await newHuman('ana')
    const bob = await newHuman('ben')
    const carol = await newHuman('cal')
    const dm = await dmBetween(alice, bob)
    const before = await sent(alice.as, dm, 'before the block')
    const group = await createGroup(db, alice, 'Shared')
    await addMember(db, group, bob)
    await addMember(db, group, carol)
    const groupMessage = await sent(alice.as, group.conversationId, 'group hello')

    await block(db, bob, alice)
    await db.expectError(send(alice.as, dm, 'still there?'), 'blocked')
    await db.expectError(send(bob.as, dm, 'go away'), 'blocked')
    await db.expectError(db.rpc('messages_list', { conversation_id: dm }, alice.as), 'blocked')
    await db.expectError(db.rpc('messages_list', { conversation_id: dm }, bob.as), 'blocked')
    await db.expectError(db.rpc('messages_since', { conversation_id: dm }, bob.as), 'blocked')
    await db.expectError(
      db.rpc('conversation_mark_read', { conversation_id: dm }, alice.as),
      'blocked',
    )
    await db.expectError(
      db.rpc('message_reaction_toggle', { message_id: before.id, reaction: '👍' }, bob.as),
      'blocked',
    )
    await db.expectError(
      db.rpc('message_edit', { message_id: before.id, text: 'x' }, alice.as),
      'blocked',
    )
    expect(await visibleRows(alice.as, dm)).toBe(0)
    expect(await visibleRows(bob.as, dm)).toBe(0)

    // The shared group stays readable and writable for both (spec §56).
    const fromBob = await sent(bob.as, group.conversationId, 'bob in the group')
    const aliceView = await page(alice.as, group.conversationId, null, 50)
    expect(aliceView.messages.map((m) => m.id)).toEqual([fromBob.id, groupMessage.id])
    const bobView = await page(bob.as, group.conversationId, null, 50)
    expect(bobView.messages.map((m) => m.id)).toEqual([fromBob.id, groupMessage.id])
    expect(await visibleRows(alice.as, group.conversationId)).toBe(2)
    expect(await visibleRows(bob.as, group.conversationId)).toBe(2)
    expect(await visibleRows(carol.as, group.conversationId)).toBe(2)
    // Direct interactions with the blocked Human stay suppressed inside the group.
    await db.expectError(
      db.rpc('message_reaction_toggle', { message_id: groupMessage.id, reaction: '👍' }, bob.as),
      'blocked',
    )
    expect((await react(carol.as, groupMessage.id, '👍')).reactions).toEqual([
      { reaction: '👍', count: 1, reactedByMe: true },
    ])
    // Unblocking restores the direct conversation.
    await db.sql.query('delete from public.blocks where blocker_human_id = $1', [bob.humanId])
    const again = await page(alice.as, dm, null, 50)
    expect(again.messages.map((m) => m.id)).toEqual([before.id])
    expect(await visibleRows(bob.as, dm)).toBe(1)
  })

  it('unread counts follow sends and conversation_mark_read', async () => {
    const group = await createGroup(db, alice, 'Unread')
    await addMember(db, group, bob)
    await addMember(db, group, carol)
    const first = await sent(alice.as, group.conversationId, 'one')
    await sent(alice.as, group.conversationId, 'two')
    const third = await sent(alice.as, group.conversationId, 'three')
    expect(await unreadOf(group.conversationId, alice)).toBe(0)
    expect(await unreadOf(group.conversationId, bob)).toBe(3)
    expect(await unreadOf(group.conversationId, carol)).toBe(3)
    expect(
      await scalar<Date>(db, 'last_message_at from public.conversations where id = $1', [
        group.conversationId,
      ]),
    ).toEqual(new Date(third.createdAt))
    expect(
      await scalar<Date>(db, 'last_activity_at from public.groups where id = $1', [group.groupId]),
    ).toEqual(new Date(third.createdAt))

    // Null message id → the newest message.
    const marked = await db.rpc<{
      conversationId: string
      lastReadMessageId: string
      lastReadAt: string
      unreadCount: number
    }>('conversation_mark_read', { conversation_id: group.conversationId }, bob.as)
    expect(marked).toMatchObject({
      conversationId: group.conversationId,
      lastReadMessageId: third.id,
      unreadCount: 0,
    })
    expect(marked.lastReadAt).toBeTruthy()
    expect(await unreadOf(group.conversationId, bob)).toBe(0)
    expect(await unreadOf(group.conversationId, carol)).toBe(3)

    const fourth = await sent(carol.as, group.conversationId, 'four')
    expect(await unreadOf(group.conversationId, bob)).toBe(1)
    expect(await unreadOf(group.conversationId, alice)).toBe(1)
    expect(await unreadOf(group.conversationId, carol)).toBe(3)

    // An explicit message id is recorded; the pointer never moves backwards.
    const explicit = await db.rpc<{ lastReadMessageId: string; unreadCount: number }>(
      'conversation_mark_read',
      { conversation_id: group.conversationId, message_id: fourth.id },
      carol.as,
    )
    expect(explicit).toMatchObject({ lastReadMessageId: fourth.id, unreadCount: 0 })
    const backwards = await db.rpc<{ lastReadMessageId: string; unreadCount: number }>(
      'conversation_mark_read',
      { conversation_id: group.conversationId, message_id: first.id },
      carol.as,
    )
    expect(backwards.lastReadMessageId).toBe(fourth.id)
    expect(await unreadOf(group.conversationId, carol)).toBe(0)
    const detail = await db.rpc<{
      members: Array<{ humanId: string; lastReadMessageId: string | null }>
    }>('conversation_get', { conversation_id: group.conversationId }, alice.as)
    expect(detail.members.find((m) => m.humanId === carol.humanId)?.lastReadMessageId).toBe(
      fourth.id,
    )
    expect(detail.members.find((m) => m.humanId === alice.humanId)?.lastReadMessageId).toBeNull()

    const dm = await dmBetween(alice, bob)
    const elsewhere = await sent(alice.as, dm, 'dm')
    await db.expectError(
      db.rpc(
        'conversation_mark_read',
        { conversation_id: group.conversationId, message_id: elsewhere.id },
        bob.as,
      ),
      'message_not_found',
    )
    // An empty conversation can be marked read too.
    const rae = await newHuman('rae')
    const empty = await dmBetween(bob, rae)
    expect(
      await db.rpc('conversation_mark_read', { conversation_id: empty }, bob.as),
    ).toMatchObject({ lastReadMessageId: null, unreadCount: 0 })
    await db.expectError(
      db.rpc('conversation_mark_read', { conversation_id: empty }, 'visitor'),
      'not_authenticated',
    )
    await db.expectError(
      db.rpc('conversation_mark_read', { conversation_id: empty }, guest.as),
      'not_a_human',
    )
  })

  it('edit is for the sender; delete is for the sender or a group moderator and leaves a tombstone that keeps replies resolvable', async () => {
    const group = await createGroup(db, alice, 'Threads')
    await addMember(db, group, bob)
    await addMember(db, group, carol, 'moderator')
    const dave = await createHuman(db, { handle: 'dave', displayName: 'Dave' })
    await addMember(db, group, dave)
    const original = await sent(bob.as, group.conversationId, 'original', { payload: { a: 1 } })
    const reply = await sent(alice.as, group.conversationId, 'a reply', {
      reply_to_message_id: original.id,
    })
    await react(alice.as, original.id, '❤️')

    const edited = MessageDtoSchema.parse(
      await db.rpc('message_edit', { message_id: original.id, text: '  edited  ' }, bob.as),
    )
    expect(edited.text).toBe('edited')
    expect(edited.editedAt).not.toBeNull()
    expect(edited.payload).toEqual({ a: 1 })
    expect(edited.reactions).toEqual([{ reaction: '❤️', count: 1, reactedByMe: false }])
    await db.expectError(
      db.rpc('message_edit', { message_id: original.id, text: 'nope' }, alice.as),
      'forbidden',
    )
    await db.expectError(
      db.rpc('message_edit', { message_id: original.id, text: 'nope' }, carol.as),
      'forbidden',
    )
    await db.expectError(
      db.rpc('message_edit', { message_id: original.id, text: '   ' }, bob.as),
      'invalid_input',
    )
    await db.expectError(
      db.rpc('message_edit', { message_id: original.id, text: 'x'.repeat(4001) }, bob.as),
      'invalid_input',
    )
    await db.expectError(
      db.rpc('message_edit', { message_id: NIL, text: 'x' }, bob.as),
      'message_not_found',
    )
    await db.expectError(
      db.rpc('message_edit', { message_id: original.id, text: 'x' }, 'visitor'),
      'not_authenticated',
    )

    // Plain members cannot delete others' messages; a moderator can.
    await db.expectError(
      db.rpc('message_delete', { message_id: original.id }, dave.as),
      'forbidden',
    )
    const tombstone = MessageDtoSchema.parse(
      await db.rpc('message_delete', { message_id: original.id }, carol.as),
    )
    expect(tombstone).toMatchObject({
      id: original.id,
      conversationId: group.conversationId,
      senderHumanId: bob.humanId,
      type: 'text',
      text: null,
      payload: {},
      replyToMessageId: null,
      createdAt: original.createdAt,
      clientId: original.clientId,
      reactions: [],
    })
    expect(tombstone.deletedAt).not.toBeNull()
    expect(await count(db, 'public.messages', 'id = $1', [original.id])).toBe(1)
    expect(await count(db, 'public.message_reactions', 'message_id = $1', [original.id])).toBe(0)
    expect(
      await count(db, 'private.audit_log', 'action = $1 and target_id = $2', [
        'message_delete',
        original.id,
      ]),
    ).toBe(1)
    // The reply still points at the tombstone and the page shows both.
    const listed = await page(alice.as, group.conversationId, null, 50)
    expect(listed.messages.find((m) => m.id === reply.id)?.replyToMessageId).toBe(original.id)
    expect(listed.messages.find((m) => m.id === original.id)?.deletedAt).not.toBeNull()
    // Tombstones are frozen: no edits, reactions or content changes; deleting again is a no-op.
    await db.expectError(
      db.rpc('message_edit', { message_id: original.id, text: 'x' }, bob.as),
      'message_not_found',
    )
    await db.expectError(
      db.rpc('message_reaction_toggle', { message_id: original.id, reaction: '👍' }, bob.as),
      'message_not_found',
    )
    expect(
      MessageDtoSchema.parse(await db.rpc('message_delete', { message_id: original.id }, bob.as))
        .deletedAt,
    ).toBe(tombstone.deletedAt)
    await expect(
      db.sql.query(`update public.messages set text = 'resurrected' where id = $1`, [original.id]),
    ).rejects.toMatchObject({ message: 'invalid_input' })
    await expect(
      db.sql.query(`update public.messages set deleted_at = null where id = $1`, [original.id]),
    ).rejects.toMatchObject({ message: 'invalid_input' })
    await expect(
      db.sql.query(`update public.messages set sender_human_id = $2 where id = $1`, [
        reply.id,
        bob.humanId,
      ]),
    ).rejects.toMatchObject({ message: 'invalid_input' })
    // A tombstone written directly loses its content too.
    const scrap = await sent(dave.as, group.conversationId, 'scrap', { payload: { b: 2 } })
    await db.sql.query('update public.messages set deleted_at = now() where id = $1', [scrap.id])
    expect(
      await scalar(
        db,
        "text is null and payload = '{}'::jsonb from public.messages where id = $1",
        [scrap.id],
      ),
    ).toBe(true)

    // The sender may delete their own message; no audit row for that.
    const own = await sent(alice.as, group.conversationId, 'mine')
    expect(
      MessageDtoSchema.parse(await db.rpc('message_delete', { message_id: own.id }, alice.as))
        .deletedAt,
    ).not.toBeNull()
    expect(
      await count(db, 'private.audit_log', 'action = $1 and target_id = $2', [
        'message_delete',
        own.id,
      ]),
    ).toBe(0)
    // In a DM only the sender may delete.
    const dm = await dmBetween(alice, bob)
    const dmMessage = await sent(alice.as, dm, 'dm')
    await db.expectError(
      db.rpc('message_delete', { message_id: dmMessage.id }, bob.as),
      'forbidden',
    )
    await db.expectError(db.rpc('message_delete', { message_id: NIL }, bob.as), 'message_not_found')
    await db.expectError(
      db.rpc('message_delete', { message_id: dmMessage.id }, guest.as),
      'not_a_human',
    )
  })

  it('reactions are unique per (message, human, reaction) and toggle on and off', async () => {
    const dm = await dmBetween(alice, bob)
    const message = await sent(alice.as, dm, 'react to me')

    expect((await react(alice.as, message.id, '👍')).reactions).toEqual([
      { reaction: '👍', count: 1, reactedByMe: true },
    ])
    expect((await react(bob.as, message.id, '👍')).reactions).toEqual([
      { reaction: '👍', count: 2, reactedByMe: true },
    ])
    expect((await react(bob.as, message.id, '🔥')).reactions).toEqual([
      { reaction: '👍', count: 2, reactedByMe: true },
      { reaction: '🔥', count: 1, reactedByMe: true },
    ])
    // Toggling again removes only the caller's reaction.
    expect((await react(alice.as, message.id, '👍')).reactions).toEqual([
      { reaction: '👍', count: 1, reactedByMe: false },
      { reaction: '🔥', count: 1, reactedByMe: false },
    ])
    expect(await count(db, 'public.message_reactions', 'message_id = $1', [message.id])).toBe(2)
    expect(
      await scalar(
        db,
        'conversation_id from public.message_reactions where message_id = $1 limit 1',
        [message.id],
      ),
    ).toBe(dm)
    // The unique key holds below the RPC too, and the trigger fills conversation_id.
    await expect(
      db.sql.query(
        `insert into public.message_reactions (message_id, human_id, reaction) values ($1, $2, '👍')`,
        [message.id, bob.humanId],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION })
    await expect(
      db.sql.query(
        `insert into public.message_reactions (message_id, human_id, reaction) values ($1, $2, '👍')`,
        [NIL, bob.humanId],
      ),
    ).rejects.toMatchObject({ message: 'message_not_found' })
    // Reactions are visible in pages for every member, with the viewer's own flag.
    const bobView = await page(bob.as, dm, null, 10)
    expect(bobView.messages[0]?.reactions).toEqual([
      { reaction: '👍', count: 1, reactedByMe: true },
      { reaction: '🔥', count: 1, reactedByMe: true },
    ])
    await db.expectError(
      db.rpc('message_reaction_toggle', { message_id: message.id, reaction: '' }, alice.as),
      'invalid_input',
    )
    await db.expectError(
      db.rpc(
        'message_reaction_toggle',
        { message_id: message.id, reaction: 'x'.repeat(17) },
        alice.as,
      ),
      'invalid_input',
    )
    await db.expectError(
      db.rpc('message_reaction_toggle', { message_id: NIL, reaction: '👍' }, alice.as),
      'message_not_found',
    )
    await db.expectError(
      db.rpc('message_reaction_toggle', { message_id: message.id, reaction: '👍' }, 'visitor'),
      'not_authenticated',
    )
    await db.expectError(
      db.rpc('message_reaction_toggle', { message_id: message.id, reaction: '👍' }, guest.as),
      'not_a_human',
    )
  })

  it('rate limit: the 61st send within a minute raises rate_limited; idempotent resends are free', async () => {
    const sender = await createHuman(db, { handle: 'ratey', displayName: 'Ratey' })
    const dm = await dmBetween(sender, bob)
    const clientIds = Array.from({ length: 60 }, () => randomUUID())
    const ids: string[] = []
    for (const clientId of clientIds) {
      const row = await db.rpc<{ id: string }>(
        'message_send',
        { conversation_id: dm, client_id: clientId, type: 'text', text: 'burst' },
        sender.as,
      )
      ids.push(row.id)
    }
    expect(new Set(ids).size).toBe(60)
    await db.expectError(
      db.rpc(
        'message_send',
        { conversation_id: dm, client_id: randomUUID(), type: 'text', text: '61' },
        sender.as,
      ),
      'rate_limited',
    )
    // A retry of an already persisted message still succeeds and creates nothing.
    const retry = await db.rpc<{ id: string }>(
      'message_send',
      { conversation_id: dm, client_id: clientIds[0] ?? '', type: 'text', text: 'burst' },
      sender.as,
    )
    expect(retry.id).toBe(ids[0])
    expect(await count(db, 'public.messages', 'conversation_id = $1', [dm])).toBe(60)
    expect(
      await scalar(db, 'count from private.rate_limits where key = $1', [
        `message_send:${sender.userId}`,
      ]),
    ).toBe(60)
    // Other callers keep their own budget.
    expect(await sent(bob.as, dm, 'unaffected')).toMatchObject({ text: 'unaffected' })
    // Once the window expires the budget returns.
    await db.sql.query(
      `update private.rate_limits
          set window_start = window_start - interval '2 minutes', expires_at = expires_at - interval '2 minutes'
        where key = $1`,
      [`message_send:${sender.userId}`],
    )
    expect(await sent(sender.as, dm, 'next minute')).toMatchObject({ text: 'next minute' })
  })

  it('a physical delete (service only) clears replies and read pointers instead of breaking them', async () => {
    const dm = await dmBetween(alice, bob)
    const target = await sent(alice.as, dm, 'target')
    const reply = await sent(bob.as, dm, 'reply', { reply_to_message_id: target.id })
    await db.rpc('conversation_mark_read', { conversation_id: dm, message_id: target.id }, bob.as)
    await db.sql.query('delete from public.messages where id = $1', [target.id])
    expect(
      await scalar(db, 'reply_to_message_id from public.messages where id = $1', [reply.id]),
    ).toBeNull()
    expect(
      await scalar(
        db,
        'last_read_message_id from public.conversation_members where conversation_id = $1 and human_id = $2',
        [dm, bob.humanId],
      ),
    ).toBeNull()
    let failure: unknown
    try {
      await db.asRole(alice.as, (c) =>
        c.query('delete from public.messages where id = $1', [reply.id]),
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(pg.DatabaseError)
    expect((failure as pg.DatabaseError).code).toBe(PERMISSION_DENIED)
  })
})
