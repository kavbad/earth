import {
  ConversationDetailDtoSchema,
  ConversationSummaryDtoSchema,
  GroupDetailDtoSchema,
} from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  addMember,
  createGroup,
  directConversation,
  human,
  joinRoom,
  scalar,
  startGroupRoom,
  type GroupFixture,
  type Human,
} from './fixtures'

describe('activeRoom pointers on chats and groups (0350; DB_API §2)', () => {
  let db: TestDb
  let owner: Human
  let member: Human
  let group: GroupFixture

  beforeAll(async () => {
    db = await createTestDb()
    owner = await human(db, 'Owner')
    member = await human(db, 'Member')
    group = await createGroup(db, owner, 'Weekend Crew')
    await addMember(db, group, member)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('group_get, conversation_get and conversations_list carry {roomId, participantCount} while the room is live', async () => {
    const before = GroupDetailDtoSchema.parse(
      await db.rpc('group_get', { group_id: group.groupId }, member.as),
    )
    expect(before.activeRoom).toBeNull()

    const started = await startGroupRoom(db, owner, group)
    const roomId = started.room.id
    await joinRoom(db, roomId, member, 'watching')

    const detail = GroupDetailDtoSchema.parse(
      await db.rpc('group_get', { group_id: group.groupId }, member.as),
    )
    expect(detail.activeRoom).toEqual({ roomId, participantCount: 2 })

    const conversation = ConversationDetailDtoSchema.parse(
      await db.rpc('conversation_get', { conversation_id: group.conversationId }, member.as),
    )
    expect(conversation.activeRoom).toEqual({ roomId, participantCount: 2 })

    const list = await db.rpc<{ conversations: unknown[] }>('conversations_list', {}, owner.as)
    const summaries = list.conversations.map((c) => ConversationSummaryDtoSchema.parse(c))
    expect(summaries.find((c) => c.id === group.conversationId)?.activeRoom).toEqual({
      roomId,
      participantCount: 2,
    })

    // The pointer follows the trigger-maintained count.
    await db.rpc('room_leave', { room_id: roomId }, member.as)
    expect(
      GroupDetailDtoSchema.parse(await db.rpc('group_get', { group_id: group.groupId }, owner.as))
        .activeRoom,
    ).toEqual({
      roomId,
      participantCount: 1,
    })

    await db.rpc('room_end', { room_id: roomId }, owner.as)
    expect(
      GroupDetailDtoSchema.parse(await db.rpc('group_get', { group_id: group.groupId }, owner.as))
        .activeRoom,
    ).toBeNull()
    expect(
      ConversationDetailDtoSchema.parse(
        await db.rpc('conversation_get', { conversation_id: group.conversationId }, owner.as),
      ).activeRoom,
    ).toBeNull()
    expect(
      await scalar(db, 'active_room_id from public.groups where id = $1', [group.groupId]),
    ).toBeNull()
  })

  it('direct rooms show on the direct conversation for both members and only while live', async () => {
    const conversationId = await directConversation(db, owner, member)
    const started = await db.rpc<{ room: { id: string } }>(
      'room_start',
      { context_type: 'direct', context_id: conversationId },
      owner.as,
    )
    const roomId = started.room.id
    for (const viewer of [owner, member]) {
      const detail = ConversationDetailDtoSchema.parse(
        await db.rpc('conversation_get', { conversation_id: conversationId }, viewer.as),
      )
      expect(detail.activeRoom).toEqual({ roomId, participantCount: 1 })
    }
    await joinRoom(db, roomId, member, 'camera', 'invited')
    expect(
      ConversationDetailDtoSchema.parse(
        await db.rpc('conversation_get', { conversation_id: conversationId }, member.as),
      ).activeRoom,
    ).toEqual({ roomId, participantCount: 2 })
    // Sweep clears the pointer once the room is gone.
    await db.rpc('room_leave', { room_id: roomId }, owner.as)
    await db.rpc('room_leave', { room_id: roomId }, member.as)
    await db.rpc('rooms_sweep', {}, 'service')
    expect(
      ConversationDetailDtoSchema.parse(
        await db.rpc('conversation_get', { conversation_id: conversationId }, member.as),
      ).activeRoom,
    ).toBeNull()
    expect(
      await scalar(db, 'active_room_id from public.conversations where id = $1', [conversationId]),
    ).toBeNull()
  })

  it('a stale pointer (room ended out of band) is healed by the sweep and never surfaces as activeRoom', async () => {
    const started = await startGroupRoom(db, owner, group)
    await db.sql.query(
      `update public.rooms set status = 'ended', ended_at = now(), ended_reason = 'oob' where id = $1`,
      [started.room.id],
    )
    expect(
      GroupDetailDtoSchema.parse(await db.rpc('group_get', { group_id: group.groupId }, owner.as))
        .activeRoom,
    ).toBeNull()
    const swept = await db.rpc<{ activeRoomPointersCleared: number }>('rooms_sweep', {}, 'service')
    expect(swept.activeRoomPointersCleared).toBe(2)
    expect(
      await scalar(db, 'active_room_id from public.groups where id = $1', [group.groupId]),
    ).toBeNull()
  })
})
