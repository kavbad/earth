/**
 * Adversarial verification of the "messaging" invariant cluster (spec §21, §27–§28, §53–§56, §83,
 * §86, §108, §128; ARCHITECTURE §5, §8, §11; DB_API §2; 0250–0290, 0950):
 *
 *   - Idempotent sends: one client id is one row — under concurrency, after a tombstone, across a
 *     new block or a lost membership a retry never writes a second row or a second notification.
 *   - Server ordering: `created_at` is server time the client cannot choose; pages, the polling
 *     fallback and the raw keyset agree on one total order that edits and tombstones never move.
 *   - Tombstones: a deleted message keeps its identity and loses its content everywhere a member
 *     can read it — rows, pages, previews and the notifications that copied the text.
 *   - Read state: the pointer never leaves its conversation (RPC or own-row update), the unread
 *     count follows the pointer, and no member can move the pointer or the count of another.
 *   - Blocks in direct conversations and replies: a blocked DM has no surface left either way
 *     (rows, receipts, summaries, sends, pointers) and comes back on unblock; a reply is a direct
 *     interaction refused across a block in any conversation, bystanders unaffected.
 *   - Notifications honour prefs: per conversation, per member, the sender's own prefs irrelevant,
 *     set through the RPC or the own-row grant, never by another member.
 *   - Realtime: every published table is a public table with RLS and a select policy, and a
 *     blocked pair shares no deliverable row of their direct conversation.
 *
 * Every sequence is RPC calls as specific callers; raw SQL only reads state, plays the service
 * (`notifications_unsent`), or takes the paths a client role really has (the own-row update grant
 * of `conversation_members`). One scratch database per file.
 */
import {
  ConversationDetailDtoSchema,
  ConversationsListDtoSchema,
  MessageDtoSchema,
  MessagesPageDtoSchema,
  type MessageDto,
} from '@earth/domain'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  addMember,
  block,
  count,
  createGroup,
  createHuman,
  scalar,
  type GroupFixture,
  type Human,
} from '../admission/fixtures'
import { directConversation, listNotifications, unsent } from '../notifications/fixtures'
import { errorCode, resetAllRateLimits } from '../safety/fixtures'

const PERMISSION_DENIED = '42501'

interface ReadState {
  conversationId: string
  lastReadMessageId: string | null
  lastReadAt: string | null
  unreadCount: number
}

interface Receipt {
  humanId: string
  lastReadMessageId: string | null
  lastReadAt?: string | null
}

async function rowsAs<T extends Record<string, unknown>>(
  db: TestDb,
  as: RoleSpec,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return db.asRole(as, async (c) => (await c.query<T>(sql, values)).rows)
}

describe('messaging invariants — adversarial verification (spec §128)', () => {
  let db: TestDb
  let handles = 0

  const human = async (name: string): Promise<Human> => {
    handles += 1
    return createHuman(db, { handle: `${name.toLowerCase()}${handles}`, displayName: name })
  }

  const send = async (
    as: RoleSpec,
    conversationId: string,
    text: string | null,
    extra: Record<string, unknown> = {},
  ): Promise<MessageDto> =>
    MessageDtoSchema.parse(
      await db.rpc(
        'message_send',
        { conversation_id: conversationId, client_id: randomUUID(), type: 'text', text, ...extra },
        as,
      ),
    )

  const page = async (
    as: RoleSpec,
    conversationId: string,
    beforeId: string | null = null,
    limit = 200,
  ) =>
    MessagesPageDtoSchema.parse(
      await db.rpc(
        'messages_list',
        { conversation_id: conversationId, before_id: beforeId, limit },
        as,
      ),
    )

  const since = async (as: RoleSpec, conversationId: string, afterId: string | null = null) =>
    MessagesPageDtoSchema.parse(
      await db.rpc('messages_since', { conversation_id: conversationId, after_id: afterId }, as),
    )

  const markRead = (as: RoleSpec, conversationId: string, messageId: string | null = null) =>
    db.rpc<ReadState>(
      'conversation_mark_read',
      { conversation_id: conversationId, message_id: messageId },
      as,
    )

  const receipts = (as: RoleSpec, conversationId: string) =>
    db.rpc<Receipt[]>('conversation_read_receipts', { conversation_id: conversationId }, as)

  const summaries = async (as: RoleSpec) =>
    ConversationsListDtoSchema.parse(
      await db.rpc('conversations_list', { cursor: null, limit: 100 }, as),
    ).conversations

  const unreadOf = (conversationId: string, who: Human) =>
    scalar<number>(
      db,
      'unread_count from public.conversation_members where conversation_id = $1 and human_id = $2',
      [conversationId, who.humanId],
    )

  const pointerOf = (conversationId: string, who: Human) =>
    scalar<string | null>(
      db,
      'last_read_message_id from public.conversation_members where conversation_id = $1 and human_id = $2',
      [conversationId, who.humanId],
    )

  /** Raw keyset order of a conversation, oldest first. */
  const keyset = async (conversationId: string): Promise<string[]> =>
    (
      await db.sql.query<{ id: string }>(
        'select id from public.messages where conversation_id = $1 order by created_at, id',
        [conversationId],
      )
    ).rows.map((r) => r.id)

  const notificationsForMessage = async (messageId: string) =>
    (
      await db.sql.query<{
        id: string
        recipient_human_id: string
        payload: Record<string, unknown>
      }>(
        `select id, recipient_human_id, payload from public.notifications where object_type = 'message' and object_id = $1 order by id`,
        [messageId],
      )
    ).rows

  beforeAll(async () => {
    db = await createTestDb()
  })

  beforeEach(async () => {
    await resetAllRateLimits(db)
  })

  afterAll(async () => {
    await db.drop()
  })

  // -------------------------------------------------------------------------------------------
  describe('idempotent sends: one client id is one row', () => {
    let alice: Human
    let bob: Human
    let dm: string

    beforeAll(async () => {
      alice = await human('Alice')
      bob = await human('Bob')
      dm = await directConversation(db, alice, bob)
    })

    it('two concurrent sends with the same client id persist one row and one notification', async () => {
      const clientId = randomUUID()
      const args = { conversation_id: dm, client_id: clientId, type: 'text', text: 'racing' }
      const [a, b] = await Promise.all([
        db.rpc<MessageDto>('message_send', args, alice.as),
        db.rpc<MessageDto>('message_send', args, alice.as),
      ])
      expect(MessageDtoSchema.parse(a).id).toBe(MessageDtoSchema.parse(b).id)
      expect(
        await count(db, 'public.messages', 'conversation_id = $1 and client_id = $2', [
          dm,
          clientId,
        ]),
      ).toBe(1)
      expect(await notificationsForMessage(a.id)).toHaveLength(1)
      expect(await unreadOf(dm, bob)).toBe(1)
    })

    it('a retry after a moderator tombstoned the message returns the tombstone, never a revived copy', async () => {
      const crew = await createGroup(db, alice, 'Retry Crew')
      await addMember(db, crew, bob)
      const clientId = randomUUID()
      const original = await send(bob.as, crew.conversationId, 'take that back', {
        client_id: clientId,
      })
      await db.rpc('message_delete', { message_id: original.id }, alice.as)
      const retry = await send(bob.as, crew.conversationId, 'take that back', {
        client_id: clientId,
      })
      expect(retry.id).toBe(original.id)
      expect(retry.deletedAt).not.toBeNull()
      expect(retry.text).toBeNull()
      expect(
        await count(db, 'public.messages', 'conversation_id = $1', [crew.conversationId]),
      ).toBe(1)
      // The sender cannot revive it through an edit either.
      expect(
        await errorCode(db.rpc('message_edit', { message_id: original.id, text: 'back' }, bob.as)),
      ).toBe('message_not_found')
    })

    it('a retry across a new block or a lost membership never writes a second row or a notification', async () => {
      const carol = await human('Carol')
      const dave = await human('Dave')
      const theirDm = await directConversation(db, carol, dave)
      const clientId = randomUUID()
      const first = await send(carol.as, theirDm, 'before', { client_id: clientId })
      await block(db, dave, carol)
      expect(await errorCode(send(carol.as, theirDm, 'before', { client_id: clientId }))).toBe(
        'blocked',
      )
      expect(await count(db, 'public.messages', 'conversation_id = $1', [theirDm])).toBe(1)
      expect(await notificationsForMessage(first.id)).toHaveLength(1)
      await db.sql.query('delete from public.blocks where blocker_human_id = $1', [dave.humanId])
      // Unblocked, the retry is the original again.
      expect((await send(carol.as, theirDm, 'before', { client_id: clientId })).id).toBe(first.id)
      expect(await count(db, 'public.messages', 'conversation_id = $1', [theirDm])).toBe(1)

      const crew = await createGroup(db, alice, 'Leavers')
      await addMember(db, crew, carol)
      const groupClientId = randomUUID()
      const inGroup = await send(carol.as, crew.conversationId, 'bye', { client_id: groupClientId })
      await db.rpc('group_leave', { group_id: crew.groupId }, carol.as)
      expect(
        await errorCode(send(carol.as, crew.conversationId, 'bye', { client_id: groupClientId })),
      ).toBe('conversation_not_found')
      // The original message and the "left" line: nothing else.
      expect(
        await count(db, 'public.messages', 'conversation_id = $1', [crew.conversationId]),
      ).toBe(2)
      expect(await notificationsForMessage(inGroup.id)).toHaveLength(1)
    })

    it('the same client id is a new message only in another conversation, for the same sender', async () => {
      const crew = await createGroup(db, alice, 'Two Threads')
      await addMember(db, crew, bob)
      const clientId = randomUUID()
      const inDm = await send(alice.as, dm, 'same id', { client_id: clientId })
      const inGroup = await send(alice.as, crew.conversationId, 'same id', { client_id: clientId })
      expect(inGroup.id).not.toBe(inDm.id)
      // A retry in each conversation resolves to its own row, whatever the text now says.
      expect((await send(alice.as, dm, 'changed', { client_id: clientId })).id).toBe(inDm.id)
      expect(
        (await send(alice.as, crew.conversationId, 'changed', { client_id: clientId })).id,
      ).toBe(inGroup.id)
      expect(await count(db, 'public.messages', 'client_id = $1', [clientId])).toBe(2)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('server ordering: one total order the client cannot bend', () => {
    let alice: Human
    let bob: Human
    let crew: GroupFixture

    beforeAll(async () => {
      alice = await human('Alice')
      bob = await human('Bob')
      crew = await createGroup(db, alice, 'Order Crew')
      await addMember(db, crew, bob)
    })

    it('created_at is the server time: a payload timestamp is inert and every read agrees with the keyset', async () => {
      const before = await scalar<Date>(db, 'now()')
      const claimed = await send(alice.as, crew.conversationId, 'from the past', {
        payload: { createdAt: '1999-12-31T23:59:59Z', created_at: '1999-12-31T23:59:59Z' },
      })
      expect(Date.parse(claimed.createdAt)).toBeGreaterThanOrEqual(before.getTime())
      expect(claimed.payload).toEqual({
        createdAt: '1999-12-31T23:59:59Z',
        created_at: '1999-12-31T23:59:59Z',
      })
      for (let i = 0; i < 6; i += 1)
        await send(i % 2 === 0 ? bob.as : alice.as, crew.conversationId, `m${i}`)
      // Rows sharing one timestamp (one transaction) still order deterministically by id.
      await db.sql.query(
        `insert into public.messages (conversation_id, sender_human_id, type, text, client_id)
         select $1, $2, 'text', 'tie' || i, gen_random_uuid() from generate_series(1, 4) i`,
        [crew.conversationId, bob.humanId],
      )
      const expected = await keyset(crew.conversationId)
      expect(expected).toHaveLength(11)
      const listed = (await page(alice.as, crew.conversationId)).messages.map((m) => m.id).reverse()
      expect(listed).toEqual(expected)
      expect((await since(bob.as, crew.conversationId)).messages.map((m) => m.id)).toEqual(expected)
      // Two pages walked from the newest join without a gap or a duplicate.
      const first = await page(bob.as, crew.conversationId, null, 5)
      const second = await page(bob.as, crew.conversationId, first.nextCursor, 20)
      expect([...first.messages, ...second.messages].map((m) => m.id).reverse()).toEqual(expected)
      // The forward walk from the middle is the tail of the same order.
      const middle = expected[5] ?? ''
      expect(
        (await since(alice.as, crew.conversationId, middle)).messages.map((m) => m.id),
      ).toEqual(expected.slice(6))
    })

    it('edits and tombstones keep their place: created_at is immutable and cursors on them stay valid', async () => {
      const order = await keyset(crew.conversationId)
      const editedId = order[3] ?? ''
      const deletedId = order[7] ?? ''
      // Edits and deletes are the sender's: pick the caller from the row.
      const senderOf = async (id: string): Promise<Human> =>
        (await scalar<string>(db, 'sender_human_id from public.messages where id = $1', [id])) ===
        alice.humanId
          ? alice
          : bob
      const edited = MessageDtoSchema.parse(
        await db.rpc(
          'message_edit',
          { message_id: editedId, text: 'edited later' },
          (await senderOf(editedId)).as,
        ),
      )
      expect(edited.editedAt).not.toBeNull()
      const tombstone = MessageDtoSchema.parse(
        await db.rpc('message_delete', { message_id: deletedId }, (await senderOf(deletedId)).as),
      )
      expect(tombstone.deletedAt).not.toBeNull()
      expect(await keyset(crew.conversationId)).toEqual(order)
      expect((await since(bob.as, crew.conversationId)).messages.map((m) => m.id)).toEqual(order)
      // Cursors pointing at the edited row and at the tombstone still resolve.
      expect(
        (await since(alice.as, crew.conversationId, deletedId)).messages.map((m) => m.id),
      ).toEqual(order.slice(8))
      expect(
        (await page(alice.as, crew.conversationId, editedId)).messages.map((m) => m.id).reverse(),
      ).toEqual(order.slice(0, 3))
      // The DTO of the tombstone still carries the original time.
      const original = await scalar<Date>(db, 'created_at from public.messages where id = $1', [
        deletedId,
      ])
      expect(new Date(tombstone.createdAt)).toEqual(original)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('tombstones: identity stays, content goes everywhere a member reads', () => {
    it('a deleted direct message leaves no text in rows, pages, previews, the notification list or the push queue', async () => {
      const alice = await human('Alice')
      const bob = await human('Bob')
      const dm = await directConversation(db, alice, bob)
      const kept = await send(alice.as, dm, 'kept line')
      const secret = await send(alice.as, dm, 'the secret plan')
      const [notification] = await notificationsForMessage(secret.id)
      expect(notification?.payload['preview']).toBe('the secret plan')

      const tombstone = MessageDtoSchema.parse(
        await db.rpc('message_delete', { message_id: secret.id }, alice.as),
      )
      expect(tombstone).toMatchObject({
        id: secret.id,
        text: null,
        payload: {},
        senderHumanId: alice.humanId,
      })
      expect(await scalar(db, 'text from public.messages where id = $1', [secret.id])).toBeNull()

      // Pages show the tombstone in place, without content.
      const bobPage = await page(bob.as, dm)
      expect(bobPage.messages.map((m) => [m.id, m.text])).toEqual([
        [secret.id, null],
        [kept.id, 'kept line'],
      ])
      // The chats row falls back to the previous message.
      const summary = (await summaries(bob.as)).find((c) => c.id === dm)
      expect(summary?.lastMessage?.id).toBe(kept.id)
      expect(JSON.stringify(summary)).not.toContain('secret plan')

      // The notification that copied the preview no longer carries it, in the list or in the queue.
      const listed = await listNotifications(db, bob.as, { limit: 50 })
      const forSecret = listed.notifications.filter((n) => n.objectId === secret.id)
      expect(JSON.stringify(forSecret)).not.toContain('secret plan')
      const queued = (await unsent(db)).filter((n) => n.objectId === secret.id)
      expect(JSON.stringify(queued)).not.toContain('secret plan')
      expect(
        await count(
          db,
          'public.notifications',
          `object_id = $1 and payload ->> 'preview' like '%secret plan%'`,
          [secret.id],
        ),
      ).toBe(0)
      // The other message's notification is untouched.
      expect((await notificationsForMessage(kept.id))[0]?.payload['preview']).toBe('kept line')
    })

    it('replies and read pointers keep resolving through a tombstone; the tombstone stays frozen for everyone', async () => {
      const alice = await human('Alice')
      const bob = await human('Bob')
      const carol = await human('Carol')
      const crew = await createGroup(db, alice, 'Frozen')
      await addMember(db, crew, bob, 'moderator')
      await addMember(db, crew, carol)
      const parent = await send(carol.as, crew.conversationId, 'parent')
      const reply = await send(alice.as, crew.conversationId, 'child', {
        reply_to_message_id: parent.id,
      })
      await markRead(alice.as, crew.conversationId, parent.id)
      await db.rpc('message_reaction_toggle', { message_id: parent.id, reaction: '👍' }, bob.as)
      const tombstone = MessageDtoSchema.parse(
        await db.rpc('message_delete', { message_id: parent.id }, bob.as),
      )
      expect(tombstone.reactions).toEqual([])
      expect(
        (await page(carol.as, crew.conversationId)).messages.find((m) => m.id === reply.id)
          ?.replyToMessageId,
      ).toBe(parent.id)
      expect(await pointerOf(crew.conversationId, alice)).toBe(parent.id)
      // A reply to the tombstone is still a reply in the same thread.
      const late = await send(bob.as, crew.conversationId, 'late', {
        reply_to_message_id: parent.id,
      })
      expect(late.replyToMessageId).toBe(parent.id)
      // Pointing the read state at the tombstone is fine; the tombstone itself is inert.
      expect((await markRead(carol.as, crew.conversationId, parent.id)).lastReadMessageId).toBe(
        parent.id,
      )
      expect(
        await errorCode(
          db.rpc('message_reaction_toggle', { message_id: parent.id, reaction: '👍' }, carol.as),
        ),
      ).toBe('message_not_found')
      expect(
        await errorCode(db.rpc('message_edit', { message_id: parent.id, text: 'again' }, carol.as)),
      ).toBe('message_not_found')
      expect(
        MessageDtoSchema.parse(await db.rpc('message_delete', { message_id: parent.id }, carol.as))
          .deletedAt,
      ).toBe(tombstone.deletedAt)
      expect(
        MessageDtoSchema.parse(await db.rpc('message_delete', { message_id: parent.id }, alice.as))
          .deletedAt,
      ).toBe(tombstone.deletedAt)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('read state: the pointer stays in its conversation and the unread count follows it', () => {
    let alice: Human
    let bob: Human
    let crew: GroupFixture
    let dm: string

    beforeAll(async () => {
      alice = await human('Alice')
      bob = await human('Bob')
      crew = await createGroup(db, alice, 'Read Crew')
      await addMember(db, crew, bob)
      dm = await directConversation(db, alice, bob)
    })

    it('the pointer cannot leave its conversation, through the RPC or the own-row update grant', async () => {
      const inDm = await send(alice.as, dm, 'dm line')
      const inGroup = await send(alice.as, crew.conversationId, 'group line')
      expect(await errorCode(markRead(bob.as, crew.conversationId, inDm.id))).toBe(
        'message_not_found',
      )
      // The own-row grant lets a member write last_read_message_id directly: it must still be a
      // message of that conversation.
      expect(
        await errorCode(
          db.asRole(bob.as, (c) =>
            c.query(
              'update public.conversation_members set last_read_message_id = $1 where conversation_id = $2 and human_id = $3',
              [inDm.id, crew.conversationId, bob.humanId],
            ),
          ),
        ),
      ).toBe('invalid_input')
      expect(await pointerOf(crew.conversationId, bob)).toBeNull()
      // A message of the conversation is accepted on that path, as the RPC would.
      const own = await db.asRole(bob.as, (c) =>
        c.query(
          'update public.conversation_members set last_read_message_id = $1 where conversation_id = $2 and human_id = $3',
          [inGroup.id, crew.conversationId, bob.humanId],
        ),
      )
      expect(own.rowCount).toBe(1)
      expect(await pointerOf(crew.conversationId, bob)).toBe(inGroup.id)
      // Nothing foreign shows up in "Seen by".
      const detail = ConversationDetailDtoSchema.parse(
        await db.rpc('conversation_get', { conversation_id: crew.conversationId }, alice.as),
      )
      expect(detail.members.find((m) => m.humanId === bob.humanId)?.lastReadMessageId).toBe(
        inGroup.id,
      )
    })

    it('marking an older message read leaves the newer ones unread; the pointer never goes backwards', async () => {
      const carol = await human('Carol')
      const thread = await createGroup(db, alice, 'Counting')
      await addMember(db, thread, carol)
      const m1 = await send(alice.as, thread.conversationId, 'one')
      const m2 = await send(alice.as, thread.conversationId, 'two')
      const m3 = await send(alice.as, thread.conversationId, 'three')
      expect(await unreadOf(thread.conversationId, carol)).toBe(3)

      const partial = await markRead(carol.as, thread.conversationId, m1.id)
      expect(partial).toMatchObject({ lastReadMessageId: m1.id, unreadCount: 2 })
      expect(await unreadOf(thread.conversationId, carol)).toBe(2)
      expect(
        (await summaries(carol.as)).find((c) => c.id === thread.conversationId)?.unreadCount,
      ).toBe(2)

      expect(await markRead(carol.as, thread.conversationId, m3.id)).toMatchObject({
        lastReadMessageId: m3.id,
        unreadCount: 0,
      })
      const m4 = await send(alice.as, thread.conversationId, 'four')
      expect(await unreadOf(thread.conversationId, carol)).toBe(1)
      // Backwards is a no-op for the pointer and never hides what is still unread.
      expect(await markRead(carol.as, thread.conversationId, m2.id)).toMatchObject({
        lastReadMessageId: m3.id,
        unreadCount: 1,
      })
      expect(await markRead(carol.as, thread.conversationId)).toMatchObject({
        lastReadMessageId: m4.id,
        unreadCount: 0,
      })
      // The sender's own messages never count for the sender.
      expect(await unreadOf(thread.conversationId, alice)).toBe(0)
      expect(await markRead(alice.as, thread.conversationId, m1.id)).toMatchObject({
        lastReadMessageId: m1.id,
        unreadCount: 0,
      })
    })

    it('no member can move the pointer, the prefs or the unread count of another', async () => {
      await send(alice.as, crew.conversationId, 'for bob')
      const before = await unreadOf(crew.conversationId, bob)
      const moved = await db.asRole(alice.as, (c) =>
        c.query(
          "update public.conversation_members set last_read_message_id = null, mute_state = 'muted' where human_id = $1",
          [bob.humanId],
        ),
      )
      expect(moved.rowCount).toBe(0)
      let failure: unknown
      try {
        await db.asRole(bob.as, (c) =>
          c.query('update public.conversation_members set unread_count = 0 where human_id = $1', [
            bob.humanId,
          ]),
        )
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(pg.DatabaseError)
      expect((failure as pg.DatabaseError).code).toBe(PERMISSION_DENIED)
      expect(await unreadOf(crew.conversationId, bob)).toBe(before)
      expect(
        await scalar(
          db,
          'mute_state from public.conversation_members where conversation_id = $1 and human_id = $2',
          [crew.conversationId, bob.humanId],
        ),
      ).toBe('none')
      // Read receipts and pointers are readable by members: that is "Seen by", not a leak.
      expect((await receipts(alice.as, crew.conversationId)).map((r) => r.humanId).sort()).toEqual(
        [alice.humanId, bob.humanId].sort(),
      )
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('blocks in direct conversations: no surface survives, either way, until the unblock', () => {
    let alice: Human
    let bob: Human
    let dm: string
    let fromAlice: MessageDto
    let fromBob: MessageDto

    beforeAll(async () => {
      alice = await human('Alice')
      bob = await human('Bob')
      dm = await directConversation(db, alice, bob)
      fromAlice = await send(alice.as, dm, 'hello')
      fromBob = await send(bob.as, dm, 'hi back')
      await markRead(alice.as, dm, fromBob.id)
      await markRead(bob.as, dm, fromAlice.id)
      await db.rpc('block_set', { target_human_id: alice.humanId }, bob.as)
      await resetAllRateLimits(db)
    })

    afterAll(async () => {
      await db.sql.query(
        'delete from public.blocks where blocker_human_id = $1 and blocked_human_id = $2',
        [bob.humanId, alice.humanId],
      )
    })

    it('every RPC of the direct conversation answers blocked for both sides', async () => {
      for (const who of [alice, bob]) {
        expect(await errorCode(send(who.as, dm, 'still there?'))).toBe('blocked')
        expect(await errorCode(db.rpc('messages_list', { conversation_id: dm }, who.as))).toBe(
          'blocked',
        )
        expect(await errorCode(db.rpc('messages_since', { conversation_id: dm }, who.as))).toBe(
          'blocked',
        )
        expect(await errorCode(db.rpc('conversation_get', { conversation_id: dm }, who.as))).toBe(
          'blocked',
        )
        expect(await errorCode(markRead(who.as, dm))).toBe('blocked')
        expect(await errorCode(receipts(who.as, dm))).toBe('blocked')
        expect(
          await errorCode(db.rpc('message_edit', { message_id: fromAlice.id, text: 'x' }, who.as)),
        ).toBe('blocked')
        expect(await errorCode(db.rpc('message_delete', { message_id: fromBob.id }, who.as))).toBe(
          'blocked',
        )
        expect(
          await errorCode(
            db.rpc('message_reaction_toggle', { message_id: fromAlice.id, reaction: '👍' }, who.as),
          ),
        ).toBe('blocked')
        expect((await summaries(who.as)).map((c) => c.id)).not.toContain(dm)
      }
      expect(
        await errorCode(
          db.rpc('conversation_direct_get_or_create', { other_human_id: bob.humanId }, alice.as),
        ),
      ).toBe('blocked')
      expect(
        await errorCode(
          db.rpc('conversation_direct_get_or_create', { other_human_id: alice.humanId }, bob.as),
        ),
      ).toBe('blocked')
    })

    it('no row of the direct conversation is selectable (so nothing is deliverable) by either side', async () => {
      for (const who of [alice, bob]) {
        expect(
          await rowsAs(db, who.as, 'select id from public.messages where conversation_id = $1', [
            dm,
          ]),
        ).toEqual([])
        expect(
          await rowsAs(
            db,
            who.as,
            'select message_id from public.message_reactions where conversation_id = $1',
            [dm],
          ),
        ).toEqual([])
        expect(
          await rowsAs(
            db,
            who.as,
            'select human_id, last_read_at from public.conversation_members where conversation_id = $1',
            [dm],
          ),
        ).toEqual([])
        expect(
          await rowsAs(db, who.as, 'select id from public.conversations where id = $1', [dm]),
        ).toEqual([])
      }
      // The rows themselves are intact for the unblock.
      expect(await count(db, 'public.messages', 'conversation_id = $1', [dm])).toBe(2)
      expect(await count(db, 'public.conversation_members', 'conversation_id = $1', [dm])).toBe(2)
    })

    it('a shared group keeps both readable, but the pair cannot reply to each other and can to anyone else', async () => {
      const carol = await human('Carol')
      const crew = await createGroup(db, carol, 'Coexist')
      await addMember(db, crew, alice)
      await addMember(db, crew, bob)
      const aliceLine = await send(alice.as, crew.conversationId, 'alice in the group')
      const bobLine = await send(bob.as, crew.conversationId, 'bob in the group')
      const carolReply = await send(carol.as, crew.conversationId, 'carol replies to bob', {
        reply_to_message_id: bobLine.id,
      })
      expect(
        await errorCode(
          send(alice.as, crew.conversationId, 'reply', { reply_to_message_id: bobLine.id }),
        ),
      ).toBe('blocked')
      expect(
        await errorCode(
          send(bob.as, crew.conversationId, 'reply', { reply_to_message_id: aliceLine.id }),
        ),
      ).toBe('blocked')
      // Replying to a bystander's reply is not an interaction with the blocked Human.
      const chained = await send(alice.as, crew.conversationId, 'to carol', {
        reply_to_message_id: carolReply.id,
      })
      expect(chained.replyToMessageId).toBe(carolReply.id)
      // A tombstone keeps its sender: still across the block.
      await db.rpc('message_delete', { message_id: bobLine.id }, bob.as)
      expect(
        await errorCode(
          send(alice.as, crew.conversationId, 'reply to a tombstone', {
            reply_to_message_id: bobLine.id,
          }),
        ),
      ).toBe('blocked')
      expect(
        await errorCode(
          db.rpc('message_reaction_toggle', { message_id: aliceLine.id, reaction: '👍' }, bob.as),
        ),
      ).toBe('blocked')
      // Both read the whole thread; the pair's own read state and receipts stay members-only facts.
      for (const who of [alice, bob, carol]) {
        expect((await page(who.as, crew.conversationId)).messages.length).toBe(4)
        expect((await receipts(who.as, crew.conversationId)).map((r) => r.humanId).sort()).toEqual(
          [alice.humanId, bob.humanId, carol.humanId].sort(),
        )
      }
      // Neither is notified of the other's group message; Carol is.
      expect(
        (await notificationsForMessage(aliceLine.id)).map((n) => n.recipient_human_id),
      ).toEqual([carol.humanId])
      expect((await notificationsForMessage(bobLine.id)).map((n) => n.recipient_human_id)).toEqual([
        carol.humanId,
      ])
    })

    it('the unblock brings the direct conversation back with its messages and read pointers', async () => {
      await db.rpc('block_set', { target_human_id: alice.humanId, blocked: false }, bob.as)
      await resetAllRateLimits(db)
      expect((await page(alice.as, dm)).messages.map((m) => m.id)).toEqual([
        fromBob.id,
        fromAlice.id,
      ])
      expect((await receipts(bob.as, dm)).map((r) => [r.humanId, r.lastReadMessageId])).toEqual(
        expect.arrayContaining([
          [alice.humanId, fromBob.id],
          [bob.humanId, fromAlice.id],
        ]),
      )
      expect(
        await rowsAs(db, alice.as, 'select id from public.conversations where id = $1', [dm]),
      ).toEqual([{ id: dm }])
      expect(
        (
          await rowsAs(
            db,
            bob.as,
            'select human_id from public.conversation_members where conversation_id = $1',
            [dm],
          )
        ).length,
      ).toBe(2)
      expect((await summaries(alice.as)).map((c) => c.id)).toContain(dm)
      const again = await send(bob.as, dm, 'we are back')
      expect(await notificationsForMessage(again.id)).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('notifications honour prefs: per conversation, per member, never set by another', () => {
    let alice: Human
    let bob: Human
    let crew: GroupFixture
    let dm: string

    beforeAll(async () => {
      alice = await human('Alice')
      bob = await human('Bob')
      crew = await createGroup(db, alice, 'Prefs Crew')
      await addMember(db, crew, bob)
      dm = await directConversation(db, alice, bob)
    })

    it('muting the group leaves the DM loud; a level set through the own-row grant is honoured too', async () => {
      await db.rpc(
        'conversation_set_prefs',
        { conversation_id: crew.conversationId, mute_state: 'muted' },
        bob.as,
      )
      const quietGroup = await send(alice.as, crew.conversationId, 'group')
      const loudDm = await send(alice.as, dm, 'direct')
      expect(await notificationsForMessage(quietGroup.id)).toEqual([])
      expect((await notificationsForMessage(loudDm.id)).map((n) => n.recipient_human_id)).toEqual([
        bob.humanId,
      ])
      // Unread counts are never a preference.
      expect(await unreadOf(crew.conversationId, bob)).toBe(1)

      const own = await db.asRole(bob.as, (c) =>
        c.query(
          "update public.conversation_members set notification_level = 'none' where conversation_id = $1 and human_id = $2",
          [dm, bob.humanId],
        ),
      )
      expect(own.rowCount).toBe(1)
      const silentDm = await send(alice.as, dm, 'direct, silenced')
      expect(await notificationsForMessage(silentDm.id)).toEqual([])
      expect(await unreadOf(dm, bob)).toBe(2)
      // Restored through the RPC.
      await db.rpc(
        'conversation_set_prefs',
        { conversation_id: dm, notification_level: 'all' },
        bob.as,
      )
      const loudAgain = await send(alice.as, dm, 'direct again')
      expect(
        (await notificationsForMessage(loudAgain.id)).map((n) => n.recipient_human_id),
      ).toEqual([bob.humanId])
    })

    it("the sender's own prefs never matter, and nobody can silence another member", async () => {
      // Bob is muted in the group: his messages still notify Alice.
      const fromMuted = await send(bob.as, crew.conversationId, 'muted sender')
      expect(
        (await notificationsForMessage(fromMuted.id)).map((n) => n.recipient_human_id),
      ).toEqual([alice.humanId])
      // Alice tries to silence Bob in the DM and to move his read pointer: nothing happens.
      const attempt = await db.asRole(alice.as, (c) =>
        c.query(
          "update public.conversation_members set notification_level = 'none', mute_state = 'muted' where conversation_id = $1 and human_id = $2",
          [dm, bob.humanId],
        ),
      )
      expect(attempt.rowCount).toBe(0)
      expect(
        await errorCode(
          db.rpc(
            'conversation_set_prefs',
            { conversation_id: dm, mute_state: 'muted' },
            (await human('Eve')).as,
          ),
        ),
      ).toBe('conversation_not_found')
      const stillLoud = await send(alice.as, dm, 'still loud')
      expect(
        (await notificationsForMessage(stillLoud.id)).map((n) => n.recipient_human_id),
      ).toEqual([bob.humanId])
      // A member removed from the group is neither notified nor counted.
      const carol = await human('Carol')
      await addMember(db, crew, carol)
      await db.rpc(
        'group_member_remove',
        { group_id: crew.groupId, human_id: carol.humanId },
        alice.as,
      )
      const afterRemoval = await send(alice.as, crew.conversationId, 'after removal')
      expect(
        (await notificationsForMessage(afterRemoval.id)).map((n) => n.recipient_human_id),
      ).toEqual([])
      expect(
        await count(db, 'public.conversation_members', 'conversation_id = $1 and human_id = $2', [
          crew.conversationId,
          carol.humanId,
        ]),
      ).toBe(0)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('realtime publication: RLS governs every published row', () => {
    it('every published table is a public table with RLS enabled and a select policy for authenticated; all three operations are published', async () => {
      const { rows } = await db.sql.query<{
        schemaname: string
        tablename: string
        rls: boolean
        select_roles: string[]
      }>(
        `select pt.schemaname, pt.tablename, c.relrowsecurity as rls,
                coalesce((select array_agg(distinct r.rolname::text)
                            from pg_policy p
                            cross join lateral unnest(p.polroles) as role(oid)
                            join pg_roles r on r.oid = role.oid
                           where p.polrelid = c.oid and p.polcmd in ('r', '*')), '{}') as select_roles
           from pg_publication_tables pt
           join pg_namespace n on n.nspname = pt.schemaname
           join pg_class c on c.relnamespace = n.oid and c.relname = pt.tablename
          where pt.pubname = 'supabase_realtime'
          order by 1, 2`,
      )
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.schemaname, row.tablename).toBe('public')
        expect(row.rls, `${row.tablename} has RLS`).toBe(true)
        expect(row.select_roles, `${row.tablename} has a select policy`).toContain('authenticated')
      }
      const names = rows.map((r) => r.tablename)
      for (const table of [
        'messages',
        'message_reactions',
        'conversation_members',
        'conversations',
        'notifications',
      ]) {
        expect(names).toContain(table)
      }
      const { rows: pub } = await db.sql.query<{
        puballtables: boolean
        pubinsert: boolean
        pubupdate: boolean
        pubdelete: boolean
      }>(
        `select puballtables, pubinsert, pubupdate, pubdelete from pg_publication where pubname = 'supabase_realtime'`,
      )
      expect(pub[0]).toEqual({
        puballtables: false,
        pubinsert: true,
        pubupdate: true,
        pubdelete: true,
      })
    })

    it('the policies behind the messaging tables are the block-aware member check, so a blocked DM delivers nothing', async () => {
      const { rows } = await db.sql.query<{ tablename: string; qual: string }>(
        `select tablename, qual from pg_policies
          where schemaname = 'public' and cmd = 'SELECT'
            and tablename in ('messages', 'message_reactions', 'conversations', 'conversation_members')
          order by tablename`,
      )
      expect(rows.map((r) => r.tablename)).toEqual([
        'conversation_members',
        'conversations',
        'message_reactions',
        'messages',
      ])
      for (const row of rows) expect(row.qual, row.tablename).toContain('can_view_conversation')
    })
  })
})
