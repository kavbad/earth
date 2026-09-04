/**
 * Authorization matrix for the messaging tables (ARCHITECTURE §15, spec §114; DB_API §2 RLS):
 * what each caller kind can select, insert, update and delete on `messages` and
 * `message_reactions` through the API roles. Nobody writes directly; reads follow conversation
 * membership and are suppressed in a direct conversation across a block.
 */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  addMember,
  befriend,
  block,
  createGroup,
  createGuest,
  createHuman,
  type Human,
} from '../admission/fixtures'
import { createTestDb, type RoleSpec, type TestDb } from '../harness'

const ACTORS = [
  'visitor',
  'guest',
  'claiming',
  'self',
  'other',
  'friend',
  'blocked',
  'member',
] as const
type Actor = (typeof ACTORS)[number]
type Outcome = 'denied' | number

interface TableCase {
  table: string
  select: Record<Actor, Outcome>
  insert: string
  update: string
  delete: string
}

const all = <T>(value: T): Record<Actor, T> =>
  Object.fromEntries(ACTORS.map((a) => [a, value])) as Record<Actor, T>

describe('RLS matrix: messages and message_reactions', () => {
  let db: TestDb
  let actorSpec: Record<Actor, RoleSpec>
  let groupConversation: string
  let friendDm: string
  let blockedDm: string
  let groupMessage: string
  let dmMessage: string
  let humans: Record<'self' | 'member' | 'friend', Human>

  const send = (as: RoleSpec, conversationId: string, text: string) =>
    db.rpc<{ id: string }>(
      'message_send',
      { conversation_id: conversationId, client_id: randomUUID(), type: 'text', text },
      as,
    )

  beforeAll(async () => {
    db = await createTestDb()
    const self = await createHuman(db, { handle: 'self', displayName: 'Self' })
    const other = await createHuman(db, { handle: 'other', displayName: 'Other' })
    const friend = await createHuman(db, { handle: 'friend', displayName: 'Friend' })
    const blocked = await createHuman(db, { handle: 'blocked', displayName: 'Blocked' })
    const member = await createHuman(db, { handle: 'member', displayName: 'Member' })
    const claiming = await createHuman(db, { handle: 'claiming', status: 'pending' })
    const guest = await createGuest(db)
    await befriend(db, self, friend)
    humans = { self, member, friend }

    const group = await createGroup(db, self, 'Crew')
    await addMember(db, group, member)
    groupConversation = group.conversationId
    friendDm = (
      await db.rpc<{ id: string }>(
        'conversation_direct_get_or_create',
        { other_human_id: friend.humanId },
        self.as,
      )
    ).id
    blockedDm = (
      await db.rpc<{ id: string }>(
        'conversation_direct_get_or_create',
        { other_human_id: blocked.humanId },
        self.as,
      )
    ).id

    groupMessage = (await send(self.as, groupConversation, 'group one')).id
    await send(self.as, groupConversation, 'group two')
    const fromMember = (await send(member.as, groupConversation, 'group three')).id
    dmMessage = (await send(self.as, friendDm, 'hi friend')).id
    const toBlocked = (await send(self.as, blockedDm, 'hi, before the block')).id

    await db.rpc('message_reaction_toggle', { message_id: fromMember, reaction: '❤️' }, self.as)
    await db.rpc('message_reaction_toggle', { message_id: groupMessage, reaction: '👍' }, member.as)
    await db.rpc('message_reaction_toggle', { message_id: dmMessage, reaction: '👍' }, friend.as)
    await db.rpc('message_reaction_toggle', { message_id: toBlocked, reaction: '👍' }, blocked.as)
    await block(db, self, blocked)

    actorSpec = {
      visitor: 'visitor',
      guest: guest.as,
      claiming: claiming.as,
      self: self.as,
      other: other.as,
      friend: friend.as,
      blocked: blocked.as,
      member: member.as,
    }
  })

  afterAll(async () => {
    await db.drop()
  })

  async function run(
    actor: Actor,
    sql: string,
  ): Promise<{ kind: 'denied' | 'rls' | 'ok'; rows: number }> {
    try {
      const result = await db.asRole(actorSpec[actor], (c) => c.query(sql), { rollback: true })
      return { kind: 'ok', rows: result.rowCount ?? 0 }
    } catch (error) {
      if (error instanceof pg.DatabaseError && error.code === '42501') {
        return { kind: error.message.includes('row-level security') ? 'rls' : 'denied', rows: 0 }
      }
      throw error
    }
  }

  const cases = (): TableCase[] => [
    {
      table: 'messages',
      // self: 3 group + 1 friend DM (the blocked DM is hidden both ways); member: 3; friend: 1.
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 4,
        other: 0,
        friend: 1,
        blocked: 0,
        member: 3,
      },
      insert: `insert into public.messages (conversation_id, sender_human_id, type, text) values ('${groupConversation}', '${humans.self.humanId}', 'text', 'direct')`,
      update: `update public.messages set text = 'edited' where id = '${groupMessage}'`,
      delete: `delete from public.messages where id = '${groupMessage}'`,
    },
    {
      table: 'message_reactions',
      // self: 2 group + 1 friend DM; member: 2; friend: 1; blocked: its own reaction is hidden by the block.
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 3,
        other: 0,
        friend: 1,
        blocked: 0,
        member: 2,
      },
      insert: `insert into public.message_reactions (message_id, human_id, reaction) values ('${dmMessage}', '${humans.friend.humanId}', '🔥')`,
      update: `update public.message_reactions set reaction = '🔥'`,
      delete: `delete from public.message_reactions`,
    },
  ]

  for (const table of ['messages', 'message_reactions']) {
    describe(`public.${table}`, () => {
      it('has row level security enabled', async () => {
        const { rows } = await db.sql.query<{ rls: boolean }>(
          'select relrowsecurity as rls from pg_class where oid = $1::regclass',
          [`public.${table}`],
        )
        expect(rows[0]?.rls).toBe(true)
      })
      for (const actor of ACTORS) {
        it(`select as ${actor}`, async () => {
          const tableCase = cases().find((c) => c.table === table)
          if (tableCase === undefined) throw new Error('missing case')
          const outcome = await run(actor, `select * from public.${table}`)
          const expected = tableCase.select[actor]
          if (expected === 'denied') expect(outcome.kind).toBe('denied')
          else expect(outcome).toEqual({ kind: 'ok', rows: expected })
        })
        for (const op of ['insert', 'update', 'delete'] as const) {
          it(`${op} as ${actor} is denied`, async () => {
            const tableCase = cases().find((c) => c.table === table)
            if (tableCase === undefined) throw new Error('missing case')
            expect((await run(actor, tableCase[op])).kind).toBe(all('denied')[actor])
          })
        }
      }
    })
  }

  it('a member of a shared group reads exactly that group thread, never the DMs', async () => {
    const rows = await db.asRole(actorSpec.member, (c) =>
      c.query<{ conversation_id: string }>('select distinct conversation_id from public.messages'),
    )
    expect(rows.rows.map((r) => r.conversation_id)).toEqual([groupConversation])
    const friendRows = await db.asRole(actorSpec.friend, (c) =>
      c.query<{ conversation_id: string }>('select distinct conversation_id from public.messages'),
    )
    expect(friendRows.rows.map((r) => r.conversation_id)).toEqual([friendDm])
    // Lifting the block reveals the direct thread again on both sides.
    await db.sql.query('delete from public.blocks')
    expect((await run('blocked', 'select * from public.messages')).rows).toBe(1)
    expect((await run('self', 'select * from public.messages')).rows).toBe(5)
    expect((await run('blocked', 'select * from public.message_reactions')).rows).toBe(1)
    expect((await run('self', 'select * from public.message_reactions')).rows).toBe(4)
    await db.sql.query(
      `insert into public.blocks (blocker_human_id, blocked_human_id) select $1, human_id from public.public_identities where handle = 'blocked'`,
      [humans.self.humanId],
    )
    expect(blockedDm).toBeTruthy()
  })
})
