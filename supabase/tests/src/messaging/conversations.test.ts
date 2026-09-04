/**
 * Conversation summaries over real messages (DB_API §2 `conversations_list` / `conversation_get`;
 * SCREEN 08; 0290): `lastMessage` previews, `unreadCount`, activity ordering and read pointers.
 */
import {
  ConversationDetailDtoSchema,
  ConversationsListDtoSchema,
  LastMessagePreviewDtoSchema,
  type ConversationSummaryDto,
} from '@earth/domain'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  addMember,
  createGroup,
  createHuman,
  createInvite,
  type Human,
} from '../admission/fixtures'
import { createTestDb, type RoleSpec, type TestDb } from '../harness'

describe('conversation summaries with messages (SCREEN 08)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human

  const send = (
    as: RoleSpec,
    conversationId: string,
    text: string | null,
    extra: Record<string, unknown> = {},
  ) =>
    db.rpc<{ id: string; createdAt: string }>(
      'message_send',
      { conversation_id: conversationId, client_id: randomUUID(), type: 'text', text, ...extra },
      as,
    )

  const listFor = async (human: Human): Promise<ConversationSummaryDto[]> =>
    ConversationsListDtoSchema.parse(await db.rpc('conversations_list', {}, human.as)).conversations

  const summaryFor = async (
    human: Human,
    conversationId: string,
  ): Promise<ConversationSummaryDto> => {
    const found = (await listFor(human)).find((c) => c.id === conversationId)
    if (found === undefined) throw new Error(`conversation ${conversationId} not listed`)
    return found
  }

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    carol = await createHuman(db, { handle: 'carol', displayName: 'Carol' })
  })

  afterAll(async () => {
    await db.drop()
  })

  it('lists the last message preview and unread count, ordered by activity', async () => {
    const dm = (
      await db.rpc<{ id: string }>(
        'conversation_direct_get_or_create',
        { other_human_id: bob.humanId },
        alice.as,
      )
    ).id
    expect(await summaryFor(bob, dm)).toMatchObject({
      lastMessage: null,
      unreadCount: 0,
      lastMessageAt: null,
    })
    const group = await createGroup(db, alice, 'Crew')
    await addMember(db, group, bob)
    // The group was created after the DM: it lists first until the DM gets a message.
    expect((await listFor(bob)).map((c) => c.id)).toEqual([group.conversationId, dm])

    const hello = await send(alice.as, dm, 'hello bob')
    const bobDm = await summaryFor(bob, dm)
    expect(LastMessagePreviewDtoSchema.parse(bobDm.lastMessage)).toEqual({
      id: hello.id,
      senderHumanId: alice.humanId,
      senderDisplayName: 'Alice',
      type: 'text',
      text: 'hello bob',
      createdAt: hello.createdAt,
    })
    expect(bobDm.unreadCount).toBe(1)
    expect(bobDm.lastMessageAt).toBe(hello.createdAt)
    expect((await summaryFor(alice, dm)).unreadCount).toBe(0)
    expect((await listFor(bob)).map((c) => c.id)).toEqual([dm, group.conversationId])

    await db.rpc('conversation_mark_read', { conversation_id: dm }, bob.as)
    expect((await summaryFor(bob, dm)).unreadCount).toBe(0)

    // Media previews carry the type and no text.
    const photo = await send(bob.as, dm, null, {
      type: 'image',
      payload: { mediaId: randomUUID() },
    })
    expect((await summaryFor(alice, dm)).lastMessage).toMatchObject({
      id: photo.id,
      type: 'image',
      text: null,
      senderDisplayName: 'Bob',
    })
    expect((await summaryFor(alice, dm)).unreadCount).toBe(1)

    // A deleted last message falls back to the previous one; activity time is unchanged.
    await db.rpc('message_delete', { message_id: photo.id }, bob.as)
    const afterDelete = await summaryFor(alice, dm)
    expect(afterDelete.lastMessage?.id).toBe(hello.id)
    expect(afterDelete.lastMessageAt).toBe(photo.createdAt)

    // Cursor pagination still walks by activity.
    type Page = { conversations: Array<{ id: string }>; nextCursor: string | null }
    const page1 = await db.rpc<Page>('conversations_list', { limit: 1 }, bob.as)
    expect(page1.conversations.map((c) => c.id)).toEqual([dm])
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await db.rpc<Page>(
      'conversations_list',
      { cursor: page1.nextCursor, limit: 1 },
      bob.as,
    )
    expect(page2.conversations.map((c) => c.id)).toEqual([group.conversationId])
  })

  it('system lines are previews too, and conversation_get exposes read pointers', async () => {
    const group = await createGroup(db, alice, 'Joined')
    const invite = await createInvite(db, group, alice)
    await db.rpc('group_invite_join', { token: invite.token }, carol.as)
    const summary = await summaryFor(alice, group.conversationId)
    expect(summary.lastMessage).toMatchObject({
      type: 'system',
      text: 'Carol joined',
      senderHumanId: carol.humanId,
      senderDisplayName: 'Carol',
    })
    expect(summary.unreadCount).toBe(1)

    const message = await send(alice.as, group.conversationId, 'welcome')
    await db.rpc(
      'conversation_mark_read',
      { conversation_id: group.conversationId, message_id: message.id },
      carol.as,
    )
    const detail = ConversationDetailDtoSchema.parse(
      await db.rpc('conversation_get', { conversation_id: group.conversationId }, alice.as),
    )
    expect(detail.lastMessage?.id).toBe(message.id)
    // Alice still has Carol's join line unread; her own message never counts.
    expect(detail.unreadCount).toBe(1)
    await db.rpc('conversation_mark_read', { conversation_id: group.conversationId }, alice.as)
    expect(
      ConversationDetailDtoSchema.parse(
        await db.rpc('conversation_get', { conversation_id: group.conversationId }, alice.as),
      ).unreadCount,
    ).toBe(0)
    expect(detail.members.map((m) => [m.handle, m.lastReadMessageId])).toEqual([
      ['alice', null],
      ['carol', message.id],
    ])
    const receipts = await db.rpc<Array<{ humanId: string; lastReadMessageId: string | null }>>(
      'conversation_read_receipts',
      { conversation_id: group.conversationId },
      alice.as,
    )
    expect(receipts.find((r) => r.humanId === carol.humanId)?.lastReadMessageId).toBe(message.id)
  })
})
