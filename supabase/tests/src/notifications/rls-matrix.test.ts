/**
 * Authorization matrix for the notification tables and RPCs (ARCHITECTURE §15, spec §114;
 * DB_API §6; 0610): what each caller kind can do with `notifications` and
 * `notification_cooldowns` through the API roles, and which RPCs each may call.
 *
 * Actors: visitor, guest, claiming (pending Human), self (the recipient under test), other
 * (a stranger), friend (friend of self), blocked (blocked by self), member (in self's group).
 */
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  PERMISSION_DENIED,
  addMember,
  befriend,
  block,
  createGroup,
  createGuest,
  createHuman,
  insertNotification,
  readAt,
  type Human,
} from './fixtures'

const ACTORS = ['visitor', 'guest', 'claiming', 'self', 'other', 'friend', 'blocked', 'member'] as const
type Actor = (typeof ACTORS)[number]
type Outcome = 'denied' | number

const all = <T>(value: T): Record<Actor, T> =>
  Object.fromEntries(ACTORS.map((a) => [a, value])) as Record<Actor, T>

describe('RLS matrix: notifications and notification_cooldowns', () => {
  let db: TestDb
  let actorSpec: Record<Actor, RoleSpec>
  let self: Human
  let friend: Human
  let selfRow: string

  beforeAll(async () => {
    db = await createTestDb()
    self = await createHuman(db, { handle: 'self', displayName: 'Self' })
    const other = await createHuman(db, { handle: 'other', displayName: 'Other' })
    friend = await createHuman(db, { handle: 'friend', displayName: 'Friend' })
    const blocked = await createHuman(db, { handle: 'blocked', displayName: 'Blocked' })
    const member = await createHuman(db, { handle: 'member', displayName: 'Member' })
    const claiming = await createHuman(db, { handle: 'claiming', status: 'pending' })
    const guest = await createGuest(db)
    await befriend(db, self, friend)
    const group = await createGroup(db, self, 'Crew')
    await addMember(db, group, member)
    await block(db, self, blocked)

    selfRow = await insertNotification(db, { recipient: self, type: 'friend_accepted', actor: friend, payload: { name: 'Friend' } })
    await insertNotification(db, { recipient: self, type: 'group_message', actor: member, objectType: 'conversation', objectId: group.conversationId, payload: { groupName: 'Crew', senderName: 'Member', preview: 'hi' } })
    await insertNotification(db, { recipient: self, type: 'follow', actor: other, payload: { name: 'Other' } })
    await insertNotification(db, { recipient: friend, type: 'friend_accepted', actor: self, payload: { name: 'Self' } })
    await db.sql.query(
      `insert into public.notification_cooldowns (recipient_human_id, room_id) values ($1, gen_random_uuid()), ($2, gen_random_uuid())`,
      [self.humanId, friend.humanId],
    )

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

  async function run(actor: Actor, sql: string, values: unknown[] = []): Promise<{ kind: 'denied' | 'rls' | 'ok'; rows: number }> {
    try {
      const result = await db.asRole(actorSpec[actor], (c) => c.query(sql, values), { rollback: true })
      return { kind: 'ok', rows: result.rowCount ?? 0 }
    } catch (error) {
      if (error instanceof pg.DatabaseError && error.code === PERMISSION_DENIED) {
        return { kind: error.message.includes('row-level security') ? 'rls' : 'denied', rows: 0 }
      }
      throw error
    }
  }

  const tables = [
    {
      table: 'notifications',
      select: { visitor: 'denied', guest: 0, claiming: 0, self: 3, other: 0, friend: 1, blocked: 0, member: 0 } as Record<Actor, Outcome>,
      insert: (actor: Actor) =>
        `insert into public.notifications (recipient_human_id, type, object_type, object_id, priority) values ('${actor === 'friend' ? friend.humanId : self.humanId}', 'follow', 'human', '${self.humanId}', 'low')`,
      update: `update public.notifications set read_at = now()`,
      delete: `delete from public.notifications`,
    },
    {
      table: 'notification_cooldowns',
      select: all<Outcome>('denied'),
      insert: () => `insert into public.notification_cooldowns (recipient_human_id, room_id) values ('${self.humanId}', gen_random_uuid())`,
      update: `update public.notification_cooldowns set sends_in_window = 0`,
      delete: `delete from public.notification_cooldowns`,
    },
  ]

  for (const spec of tables) {
    describe(`public.${spec.table}`, () => {
      it('has row level security enabled', async () => {
        const { rows } = await db.sql.query<{ ok: boolean }>('select relrowsecurity as ok from pg_class where oid = $1::regclass', [`public.${spec.table}`])
        expect(rows[0]?.ok).toBe(true)
      })

      for (const actor of ACTORS) {
        it(`select as ${actor}`, async () => {
          const result = await run(actor, `select * from public.${spec.table}`)
          const expected = spec.select[actor]
          if (expected === 'denied') expect(result.kind).toBe('denied')
          else expect(result).toEqual({ kind: 'ok', rows: expected })
        })

        it(`insert / update / delete as ${actor} are denied`, async () => {
          expect((await run(actor, spec.insert(actor))).kind, 'insert').toBe('denied')
          expect((await run(actor, spec.update)).kind, 'update').toBe('denied')
          expect((await run(actor, spec.delete)).kind, 'delete').toBe('denied')
        })
      }
    })
  }

  it('a column-level update of read_at is not granted either; read state goes through the RPCs', async () => {
    const own = await run('self', 'update public.notifications set read_at = now() where id = $1', [selfRow])
    expect(own.kind).toBe('denied')
    expect(await readAt(db, selfRow)).toBeNull()
    const { rows } = await db.sql.query<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'notifications' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'`,
    )
    expect(rows).toEqual([])
  })

  it('selected rows never expose another recipient, even for the actor of the notification', async () => {
    const asFriend = await db.asRole(actorSpec.friend, (c) => c.query<{ recipient_human_id: string }>('select recipient_human_id from public.notifications'))
    expect(asFriend.rows.map((r) => r.recipient_human_id)).toEqual([friend.humanId])
    const asSelf = await db.asRole(actorSpec.self, (c) => c.query<{ recipient_human_id: string }>('select recipient_human_id from public.notifications'))
    expect(new Set(asSelf.rows.map((r) => r.recipient_human_id))).toEqual(new Set([self.humanId]))
  })

  describe('RPC matrix', () => {
    const humanRpcs: Array<[string, () => Record<string, unknown>]> = [
      ['notifications_list', () => ({ cursor: null, limit: 10 })],
      ['notifications_unread_count', () => ({})],
      ['notification_mark_read', () => ({ id: selfRow })],
      ['notifications_mark_all_read', () => ({})],
    ]
    const stateError: Partial<Record<Actor, string>> = {
      visitor: 'not_authenticated',
      guest: 'not_a_human',
      claiming: 'not_a_human',
    }

    for (const [name, args] of humanRpcs) {
      for (const actor of ACTORS) {
        it(`${name} as ${actor}`, async () => {
          const expected = stateError[actor]
          if (expected !== undefined) {
            await db.expectError(db.rpc(name, args(), actorSpec[actor]), expected)
            return
          }
          if (name === 'notification_mark_read' && actor !== 'self') {
            await db.expectError(db.rpc(name, args(), actorSpec[actor]), 'not_visible')
            return
          }
          await db.asRole(actorSpec[actor], async (client) => {
            const keys = Object.keys(args())
            const placeholders = keys.map((key, i) => `"${key}" => $${i + 1}`).join(', ')
            const { rows } = await client.query<{ r: Record<string, unknown> }>(
              `select public."${name}"(${placeholders}) as r`,
              keys.map((k) => args()[k]),
            )
            const result = rows[0]?.r
            if (name === 'notifications_list') {
              expect(result).toMatchObject({ nextCursor: null })
              expect((result?.['notifications'] as unknown[]).length).toBe(actor === 'self' ? 3 : actor === 'friend' ? 1 : 0)
            } else if (name === 'notifications_unread_count') {
              expect(result).toEqual({ unreadCount: actor === 'self' ? 3 : actor === 'friend' ? 1 : 0 })
            } else if (name === 'notifications_mark_all_read') {
              expect(result).toEqual({ markedCount: actor === 'self' ? 3 : actor === 'friend' ? 1 : 0, unreadCount: 0 })
            } else {
              expect(result).toMatchObject({ id: selfRow })
            }
          }, { rollback: true })
        })
      }
    }

    for (const name of ['notifications_unsent', 'notifications_mark_pushed', 'notifications_prune']) {
      it(`${name} is denied to every API caller but the service`, async () => {
        const args = name === 'notifications_mark_pushed' ? { ids: [selfRow] } : name === 'notifications_prune' ? { days: 90 } : { limit: 10 }
        for (const actor of ACTORS) {
          await expect(db.rpc(name, args, actorSpec[actor]), actor).rejects.toSatisfy(
            (error: unknown) => error instanceof pg.DatabaseError && error.code === PERMISSION_DENIED,
          )
        }
        const result = await db.rpc<Record<string, unknown> | unknown[]>(name, args, 'service')
        expect(result).toBeDefined()
      })
    }
  })
})
