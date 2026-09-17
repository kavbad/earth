/**
 * Message notifications (spec §86; DB_API §2 `message_send`; ARCHITECTURE §11): created for the
 * recipients that want them — every member but the sender with `notification_level = 'all'` and
 * `mute_state = 'none'`, never across a block — with the payload the copy builder reads
 * (`NOTIFICATION_PAYLOAD_SCHEMAS`): a 120-character preview, the conversation, the sender's name
 * and, for groups, the group's name (or generated title).
 */
import { NOTIFICATION_PAYLOAD_SCHEMAS } from '@earth/domain'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  addMember,
  block,
  count,
  createGroup,
  createHuman,
  createInvite,
  scalar,
  type GroupFixture,
  type Human,
} from '../admission/fixtures'
import { createTestDb, type RoleSpec, type TestDb } from '../harness'

interface NotificationRow {
  recipient_human_id: string
  type: string
  actor_human_id: string | null
  object_type: string
  object_id: string
  priority: string
  payload: Record<string, unknown>
}

describe('message notifications (spec §86)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human
  let dave: Human
  let erin: Human
  let frank: Human
  let george: Human
  let henry: Human
  let crew: GroupFixture

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

  const dmBetween = async (a: Human, b: Human): Promise<string> =>
    (
      await db.rpc<{ id: string }>(
        'conversation_direct_get_or_create',
        { other_human_id: b.humanId },
        a.as,
      )
    ).id

  const notificationsForMessage = async (messageId: string): Promise<NotificationRow[]> =>
    (
      await db.sql.query<NotificationRow>(
        `select recipient_human_id, type::text as type, actor_human_id, object_type, object_id, priority::text as priority, payload
           from public.notifications where object_type = 'message' and object_id = $1
          order by recipient_human_id`,
        [messageId],
      )
    ).rows

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    carol = await createHuman(db, { handle: 'carol', displayName: 'Carol' })
    dave = await createHuman(db, { handle: 'dave', displayName: 'Dave' })
    erin = await createHuman(db, { handle: 'erin', displayName: 'Erin' })
    frank = await createHuman(db, { handle: 'frank', displayName: 'Frank' })
    george = await createHuman(db, { handle: 'george', displayName: 'George' })
    henry = await createHuman(db, { handle: 'henry', displayName: 'Henry' })
    crew = await createGroup(db, alice, 'Weekend Crew')
    for (const member of [bob, carol, dave, erin, frank, george, henry])
      await addMember(db, crew, member)
    await block(db, erin, alice)
    await db.rpc(
      'conversation_set_prefs',
      { conversation_id: crew.conversationId, mute_state: 'muted' },
      frank.as,
    )
    await db.rpc(
      'conversation_set_prefs',
      { conversation_id: crew.conversationId, notification_level: 'none' },
      george.as,
    )
    await db.rpc(
      'conversation_set_prefs',
      { conversation_id: crew.conversationId, notification_level: 'mentions' },
      henry.as,
    )
  })

  beforeEach(async () => {
    await db.sql.query('delete from private.rate_limits')
  })

  afterAll(async () => {
    await db.drop()
  })

  it('group messages notify members with notification_level=all and mute_state=none, never the sender or a blocked pair', async () => {
    const message = await send(alice.as, crew.conversationId, 'hello crew')
    const rows = await notificationsForMessage(message.id)
    expect(rows.map((r) => r.recipient_human_id).sort()).toEqual(
      [bob.humanId, carol.humanId, dave.humanId].sort(),
    )
    for (const row of rows) {
      expect(row).toMatchObject({
        type: 'group_message',
        actor_human_id: alice.humanId,
        object_type: 'message',
        object_id: message.id,
        priority: 'normal',
      })
      expect(NOTIFICATION_PAYLOAD_SCHEMAS.group_message.parse(row.payload)).toEqual({
        groupName: 'Weekend Crew',
        senderName: 'Alice',
        preview: 'hello crew',
      })
      expect(row.payload['conversationId']).toBe(crew.conversationId)
    }
    // Preferences suppress notifications but never unread counts.
    for (const quiet of [frank, george, henry]) {
      expect(
        await scalar(
          db,
          'unread_count from public.conversation_members where conversation_id = $1 and human_id = $2',
          [crew.conversationId, quiet.humanId],
        ),
      ).toBe(1)
    }
    expect(
      await count(db, 'public.notifications', 'recipient_human_id = $1', [alice.humanId]),
    ).toBe(0)
    expect(await count(db, 'public.notifications', 'recipient_human_id = $1', [erin.humanId])).toBe(
      0,
    )

    // The blocked member's own message reaches everyone but the Human on the other side of the block.
    const fromErin = await send(erin.as, crew.conversationId, 'erin here')
    const recipients = (await notificationsForMessage(fromErin.id))
      .map((r) => r.recipient_human_id)
      .sort()
    expect(recipients).toEqual([bob.humanId, carol.humanId, dave.humanId].sort())
    expect(recipients).not.toContain(alice.humanId)

    // An idempotent retry creates nothing new.
    const clientId = randomUUID()
    const once = await db.rpc<{ id: string }>(
      'message_send',
      { conversation_id: crew.conversationId, client_id: clientId, type: 'text', text: 'once' },
      bob.as,
    )
    await db.rpc(
      'message_send',
      { conversation_id: crew.conversationId, client_id: clientId, type: 'text', text: 'once' },
      bob.as,
    )
    // Bob's message reaches alice, carol, dave and erin (frank, george and henry opted out).
    expect(
      await count(db, 'public.notifications', "object_type = 'message' and object_id = $1", [
        once.id,
      ]),
    ).toBe(4)
  })

  it('direct messages notify the other Human with a high priority direct_message', async () => {
    const dm = await dmBetween(alice, bob)
    const message = await send(alice.as, dm, 'just you')
    const rows = await notificationsForMessage(message.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      recipient_human_id: bob.humanId,
      type: 'direct_message',
      actor_human_id: alice.humanId,
      priority: 'high',
    })
    expect(NOTIFICATION_PAYLOAD_SCHEMAS.direct_message.parse(rows[0]?.payload)).toEqual({
      senderName: 'Alice',
      preview: 'just you',
    })
    expect(rows[0]?.payload).toEqual({
      senderName: 'Alice',
      preview: 'just you',
      conversationId: dm,
    })
    // A muted DM stays silent.
    await db.rpc('conversation_set_prefs', { conversation_id: dm, mute_state: 'muted' }, bob.as)
    const silent = await send(alice.as, dm, 'muted')
    expect(await notificationsForMessage(silent.id)).toEqual([])
    await db.rpc('conversation_set_prefs', { conversation_id: dm, mute_state: 'none' }, bob.as)
    // A blocked pair cannot send at all, so nothing is created.
    await block(db, bob, alice)
    await db.expectError(send(alice.as, dm, 'blocked'), 'blocked')
    await db.sql.query('delete from public.blocks where blocker_human_id = $1', [bob.humanId])
  })

  it('previews are one line, at most 120 characters, and label media without a caption', async () => {
    const dm = await dmBetween(alice, carol)
    const long = await send(alice.as, dm, 'x'.repeat(300))
    const [longRow] = await notificationsForMessage(long.id)
    expect((longRow?.payload['preview'] as string).length).toBe(120)
    expect(longRow?.payload['preview']).toBe('x'.repeat(120))

    const multiline = await send(alice.as, dm, '  first line\n\n  second   line  ')
    const [multilineRow] = await notificationsForMessage(multiline.id)
    expect(multilineRow?.payload['preview']).toBe('first line second line')

    const photo = await send(alice.as, dm, null, {
      type: 'image',
      payload: { mediaId: randomUUID() },
    })
    const [photoRow] = await notificationsForMessage(photo.id)
    expect(photoRow?.payload['preview']).toBe('Photo')

    const captioned = await send(alice.as, dm, 'look at this', { type: 'video' })
    const [captionedRow] = await notificationsForMessage(captioned.id)
    expect(captionedRow?.payload['preview']).toBe('look at this')

    for (const [type, label] of [
      ['audio', 'Voice message'],
      ['file', 'File'],
      ['poll', 'Poll'],
      ['place', 'Place'],
      ['plan', 'Plan'],
    ] as const) {
      const media = await send(alice.as, dm, null, { type })
      const [row] = await notificationsForMessage(media.id)
      expect(row?.payload['preview']).toBe(label)
    }
  })

  it('a nameless group conversation uses the generated title as groupName, per recipient', async () => {
    const summary = await db.rpc<{ id: string }>(
      'conversation_group_create',
      { human_ids: [bob.humanId, carol.humanId] },
      alice.as,
    )
    const message = await send(alice.as, summary.id, 'no name here')
    const rows = await notificationsForMessage(message.id)
    const byRecipient = Object.fromEntries(
      rows.map((r) => [r.recipient_human_id, r.payload['groupName']]),
    )
    expect(byRecipient).toEqual({ [bob.humanId]: 'Alice + Carol', [carol.humanId]: 'Alice + Bob' })
    for (const row of rows)
      expect(NOTIFICATION_PAYLOAD_SCHEMAS.group_message.safeParse(row.payload).success).toBe(true)
  })

  it('system messages create no notifications', async () => {
    const before = await count(db, 'public.notifications')
    const ian = await createHuman(db, { handle: 'ian', displayName: 'Ian' })
    const invite = await createInvite(db, crew, alice)
    const joined = await db.rpc<{ conversationId: string }>(
      'group_invite_join',
      { token: invite.token },
      ian.as,
    )
    expect(joined.conversationId).toBe(crew.conversationId)
    expect(
      await count(db, 'public.messages', "conversation_id = $1 and type = 'system'", [
        crew.conversationId,
      ]),
    ).toBe(1)
    expect(await count(db, 'public.notifications')).toBe(before)
    await db.rpc('group_leave', { group_id: crew.groupId }, ian.as)
    expect(await count(db, 'public.notifications')).toBe(before)
  })
})
