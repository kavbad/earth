/**
 * System messages (DB_API §2 `group_invite_join`; spec §27; 0270 `earth.system_message`, 0275):
 * "<name> joined" / "<name> left" lines written by group joins (invite and claim paths) and leaves,
 * with the helper's own validation.
 */
import { MessageDtoSchema, MessagesPageDtoSchema } from '@earth/domain'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  addMember,
  count,
  createGroup,
  createHuman,
  createInvite,
  scalar,
  type Human,
} from '../admission/fixtures'
import { createTestDb, type TestDb } from '../harness'

const NIL = '00000000-0000-0000-0000-000000000000'

interface SystemRow {
  id: string
  type: string
  text: string | null
  sender_human_id: string
  client_id: string | null
  payload: Record<string, unknown>
}

describe('system messages', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human

  const systemRows = async (conversationId: string): Promise<SystemRow[]> =>
    (
      await db.sql.query<SystemRow>(
        `select id, type::text as type, text, sender_human_id, client_id, payload
           from public.messages where conversation_id = $1 and type = 'system' order by created_at, id`,
        [conversationId],
      )
    ).rows

  const unreadOf = (conversationId: string, human: Human) =>
    scalar<number>(db, 'unread_count from public.conversation_members where conversation_id = $1 and human_id = $2', [
      conversationId,
      human.humanId,
    ])

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    carol = await createHuman(db, { handle: 'carol', displayName: 'Carol' })
    await db.sql.query(`
      create function public.probe_system_message(conversation_id uuid, text text, payload jsonb default '{}'::jsonb, actor uuid default null)
      returns uuid language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.system_message(conversation_id, text, payload, actor) $$;
      create function public.probe_system_message_legacy(conversation_id uuid, human_id uuid, text text)
      returns uuid language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.system_message(conversation_id, human_id, text) $$;
      grant execute on function public.probe_system_message(uuid, text, jsonb, uuid) to service_role, authenticated;
      grant execute on function public.probe_system_message_legacy(uuid, uuid, text) to service_role;
    `)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('group_invite_join writes "<name> joined" once, read by members, unread for everyone but the joiner', async () => {
    const group = await createGroup(db, alice, 'Joiners')
    await addMember(db, group, carol)
    const invite = await createInvite(db, group, alice)
    const joined = await db.rpc<{ conversationId: string; alreadyMember: boolean }>(
      'group_invite_join',
      { token: invite.token },
      bob.as,
    )
    expect(joined.alreadyMember).toBe(false)
    const rows = await systemRows(group.conversationId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      type: 'system',
      text: 'Bob joined',
      sender_human_id: bob.humanId,
      client_id: null,
      payload: { kind: 'member_joined', actorHumanId: bob.humanId },
    })
    expect(await unreadOf(group.conversationId, alice)).toBe(1)
    expect(await unreadOf(group.conversationId, carol)).toBe(1)
    expect(await unreadOf(group.conversationId, bob)).toBe(0)
    expect(await scalar<Date | null>(db, 'last_message_at from public.conversations where id = $1', [group.conversationId])).not.toBeNull()
    expect(await count(db, 'public.notifications')).toBe(0)

    // Everyone in the group reads it through the RPC and the policy, shaped as a MessageDto.
    const pageForCarol = MessagesPageDtoSchema.parse(await db.rpc('messages_list', { conversation_id: group.conversationId }, carol.as))
    expect(pageForCarol.messages).toHaveLength(1)
    expect(pageForCarol.messages[0]).toMatchObject({
      type: 'system',
      text: 'Bob joined',
      senderHumanId: bob.humanId,
      clientId: null,
      payload: { kind: 'member_joined', actorHumanId: bob.humanId },
    })
    const direct = await db.asRole(bob.as, (c) => c.query('select id from public.messages where conversation_id = $1', [group.conversationId]))
    expect(direct.rowCount).toBe(1)

    // Joining again as a member adds nothing.
    const again = await db.rpc<{ alreadyMember: boolean }>('group_invite_join', { token: invite.token }, bob.as)
    expect(again.alreadyMember).toBe(true)
    expect(await systemRows(group.conversationId)).toHaveLength(1)

    // The actor may not edit a system line, but clients cannot fake one either.
    await db.expectError(db.rpc('message_edit', { message_id: rows[0]?.id, text: 'x' }, bob.as), 'forbidden')
    await db.expectError(
      db.rpc('message_send', { conversation_id: group.conversationId, client_id: randomUUID(), type: 'system', text: 'fake' }, bob.as),
      'invalid_input',
    )
  })

  it('group_leave writes "<name> left" while the leaver can still be a sender, then removes access', async () => {
    const group = await createGroup(db, alice, 'Leavers')
    await addMember(db, group, bob)
    await addMember(db, group, carol)
    await db.rpc('group_leave', { group_id: group.groupId }, bob.as)
    const rows = await systemRows(group.conversationId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      text: 'Bob left',
      sender_human_id: bob.humanId,
      payload: { kind: 'member_left', actorHumanId: bob.humanId },
    })
    expect(await unreadOf(group.conversationId, alice)).toBe(1)
    expect(await unreadOf(group.conversationId, carol)).toBe(1)
    expect(await count(db, 'public.conversation_members', 'conversation_id = $1 and human_id = $2', [group.conversationId, bob.humanId])).toBe(0)
    await db.expectError(db.rpc('messages_list', { conversation_id: group.conversationId }, bob.as), 'conversation_not_found')
    const aliceView = MessagesPageDtoSchema.parse(await db.rpc('messages_list', { conversation_id: group.conversationId }, alice.as))
    expect(aliceView.messages.map((m) => m.text)).toEqual(['Bob left'])
    expect(await scalar<Date | null>(db, 'last_activity_at from public.groups where id = $1', [group.groupId])).not.toBeNull()

    // The last member leaving still records the line before the group is archived.
    await db.rpc('group_leave', { group_id: group.groupId }, carol.as)
    const left = await db.rpc<{ archived: boolean }>('group_leave', { group_id: group.groupId }, alice.as)
    expect(left.archived).toBe(true)
    expect((await systemRows(group.conversationId)).map((r) => r.text)).toEqual(['Bob left', 'Carol left', 'Alice left'])
  })

  it('claim_complete with a join_group intent also writes "<name> joined"', async () => {
    const group = await createGroup(db, alice, 'Claimers')
    const invite = await createInvite(db, group, alice)
    const newcomer = await createHuman(db, { handle: 'newbie', displayName: 'Newbie', status: 'pending' })
    await db.sql.query(
      `update public.humans set claim_intent = 'join_group', claim_invite_token_hash = earth.sha256_hex($2) where id = $1`,
      [newcomer.humanId, invite.token],
    )
    const done = await db.rpc<{ groupId: string; conversationId: string }>('claim_complete', {}, newcomer.as)
    expect(done).toMatchObject({ groupId: group.groupId, conversationId: group.conversationId })
    const rows = await systemRows(group.conversationId)
    expect(rows.map((r) => r.text)).toEqual(['Newbie joined'])
    expect(rows[0]?.sender_human_id).toBe(newcomer.humanId)
    const page = MessagesPageDtoSchema.parse(await db.rpc('messages_list', { conversation_id: group.conversationId }, newcomer.as))
    expect(page.messages.map((m) => m.text)).toEqual(['Newbie joined'])
  })

  it('earth.system_message validates its input and resolves the acting Human', async () => {
    const group = await createGroup(db, alice, 'Probe')
    await addMember(db, group, bob)
    const probe = (args: Record<string, unknown>) => db.rpc<string>('probe_system_message', args, 'service')

    const explicit = await probe({ conversation_id: group.conversationId, text: 'Room started', payload: { kind: 'room_started' }, actor: alice.humanId })
    const fromPayload = await probe({
      conversation_id: group.conversationId,
      text: 'Room ended',
      payload: { kind: 'room_ended', actorHumanId: bob.humanId },
    })
    const legacy = await db.rpc<string>(
      'probe_system_message_legacy',
      { conversation_id: group.conversationId, human_id: alice.humanId, text: 'Legacy line' },
      'service',
    )
    const rows = await systemRows(group.conversationId)
    expect(rows.map((r) => [r.id, r.text, r.sender_human_id, r.payload])).toEqual([
      [explicit, 'Room started', alice.humanId, { kind: 'room_started', actorHumanId: alice.humanId }],
      [fromPayload, 'Room ended', bob.humanId, { kind: 'room_ended', actorHumanId: bob.humanId }],
      [legacy, 'Legacy line', alice.humanId, { actorHumanId: alice.humanId }],
    ])
    // A Human caller is the default actor.
    const mine = await db.rpc<string>('probe_system_message', { conversation_id: group.conversationId, text: 'By me' }, bob.as)
    expect(MessageDtoSchema.parse(await db.rpc('messages_list', { conversation_id: group.conversationId, limit: 1 }, bob.as).then((p) => (p as { messages: unknown[] }).messages[0]))).toMatchObject({
      id: mine,
      senderHumanId: bob.humanId,
      type: 'system',
      text: 'By me',
    })
    // Two lines acted by each: unread for the other one only.
    expect(await unreadOf(group.conversationId, alice)).toBe(2)
    expect(await unreadOf(group.conversationId, bob)).toBe(2)

    await db.expectError(probe({ conversation_id: NIL, text: 'x', actor: alice.humanId }), 'conversation_not_found')
    await db.expectError(probe({ conversation_id: group.conversationId, text: '   ', actor: alice.humanId }), 'invalid_input')
    await db.expectError(probe({ conversation_id: group.conversationId, text: 'x', payload: '[1]', actor: alice.humanId }), 'invalid_input')
    // The service has no Human of its own: an actor is required.
    await db.expectError(probe({ conversation_id: group.conversationId, text: 'x' }), 'invalid_input')
    // The helper is not reachable by API roles.
    for (const [signature, role] of [
      ['earth.system_message(uuid, text, jsonb, uuid)', 'anon'],
      ['earth.system_message(uuid, text, jsonb, uuid)', 'authenticated'],
      ['earth.system_message(uuid, uuid, text)', 'anon'],
      ['earth.system_message(uuid, uuid, text)', 'authenticated'],
    ]) {
      expect(await scalar(db, 'has_function_privilege($1, $2, $3)', [role, signature, 'EXECUTE']), `${role} on ${signature}`).toBe(false)
    }
  })
})
