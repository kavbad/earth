/**
 * Authorization matrix for `reports` (ARCHITECTURE §15, spec §114; DB_API §7): what each caller
 * kind can select, insert, update and delete through the API roles.
 *
 * Actors: visitor, guest1 (a Guest who filed a report), guest2 (another Guest of the same room),
 * claiming (pending Human), self (the Human who filed a report), other (the reported Human),
 * friend (friend of self), blocked (blocked by self), member (shares a group with self), plus the
 * service role. Every mutation runs in a rolled-back transaction so the seed stays intact.
 */
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  addMember,
  befriend,
  block,
  createGroup,
  createGuest,
  createGuestSession,
  createHuman,
  createReport,
  createRoomInvite,
  human,
  startStandaloneRoom,
  type Human,
} from './fixtures'

const ACTORS = [
  'visitor',
  'guest1',
  'guest2',
  'claiming',
  'self',
  'other',
  'friend',
  'blocked',
  'member',
  'service',
] as const
type Actor = (typeof ACTORS)[number]

/** `denied` = no privilege (42501); `rls` = privilege but the row policy refused; `ok` = written. */
type WriteOutcome = 'denied' | 'rls' | 'ok'
type CountOutcome = 'denied' | number

const clientsDenied = (service: WriteOutcome): Record<Actor, WriteOutcome> =>
  Object.fromEntries(ACTORS.map((a) => [a, a === 'service' ? service : 'denied'])) as Record<
    Actor,
    WriteOutcome
  >

describe('RLS matrix over public.reports', () => {
  let db: TestDb
  let actorSpec: Record<Actor, RoleSpec>
  let self: Human
  let other: Human
  let roomId: string
  let selfReportId: string
  let guestReportId: string

  beforeAll(async () => {
    db = await createTestDb()
    self = await human(db, 'Self')
    other = await human(db, 'Other')
    const friend = await human(db, 'Friend')
    const blocked = await human(db, 'Blocked')
    const member = await human(db, 'Member')
    const claiming = await createHuman(db, { handle: 'claiming', status: 'pending' })
    await befriend(db, self, friend)
    await block(db, self, blocked)
    const group = await createGroup(db, self, 'Crew')
    await addMember(db, group, member)

    const room = await startStandaloneRoom(db, self)
    roomId = room.room.id
    const invite = await createRoomInvite(db, roomId, self)
    const guest1 = await createGuest(db)
    const guest2 = await createGuest(db)
    await createGuestSession(db, guest1, invite.token, 'Sam')
    await createGuestSession(db, guest2, invite.token, 'Pat')

    selfReportId = (
      await createReport(db, self.as, {
        targetType: 'human',
        targetId: other.humanId,
        reason: 'harassment',
      })
    ).id
    guestReportId = (
      await createReport(db, guest1.as, { targetType: 'room', targetId: roomId, reason: 'hate' })
    ).id

    actorSpec = {
      visitor: 'visitor',
      guest1: guest1.as,
      guest2: guest2.as,
      claiming: claiming.as,
      self: self.as,
      other: other.as,
      friend: friend.as,
      blocked: blocked.as,
      member: member.as,
      service: 'service',
    }
  })

  afterAll(async () => {
    await db.drop()
  })

  async function run(actor: Actor, sql: string): Promise<{ kind: WriteOutcome; rows: number }> {
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

  const expectedSelect = (): Record<Actor, CountOutcome> => ({
    visitor: 'denied',
    guest1: 1,
    guest2: 0,
    claiming: 0,
    self: 1,
    other: 0,
    friend: 0,
    blocked: 0,
    member: 0,
    service: 2,
  })

  for (const actor of ACTORS) {
    it(`select as ${actor}`, async () => {
      const outcome = await run(actor, 'select id from public.reports')
      const expected = expectedSelect()[actor]
      if (expected === 'denied') expect(outcome.kind).toBe('denied')
      else {
        expect(outcome.kind).toBe('ok')
        expect(outcome.rows).toBe(expected)
      }
    })

    it(`insert as ${actor}`, async () => {
      const outcome = await run(
        actor,
        `insert into public.reports (reporter_kind, reporter_human_id, target_type, target_id, reason) values ('human', '${self.humanId}', 'human', '${other.humanId}', 'other')`,
      )
      expect(outcome.kind).toBe(clientsDenied('ok')[actor])
    })

    it(`update as ${actor}`, async () => {
      const outcome = await run(
        actor,
        `update public.reports set status = 'resolved', resolved_at = now()`,
      )
      expect(outcome.kind).toBe(clientsDenied('ok')[actor])
      if (actor === 'service') expect(outcome.rows).toBe(2)
    })

    it(`delete as ${actor}`, async () => {
      const outcome = await run(actor, 'delete from public.reports')
      expect(outcome.kind).toBe(clientsDenied('ok')[actor])
      if (actor === 'service') expect(outcome.rows).toBe(2)
    })
  }

  it('the reporter sees exactly their own row, a Guest exactly theirs', async () => {
    const mine = await db.asRole(self.as, (c) =>
      c.query<{ id: string }>('select id from public.reports'),
    )
    expect(mine.rows.map((r) => r.id)).toEqual([selfReportId])
    const guest = await db.asRole(actorSpec.guest1, (c) =>
      c.query<{ id: string }>('select id from public.reports'),
    )
    expect(guest.rows.map((r) => r.id)).toEqual([guestReportId])
    // The reported Human never learns about the report.
    const target = await db.asRole(other.as, (c) =>
      c.query('select id from public.reports where target_id = $1', [other.humanId]),
    )
    expect(target.rowCount).toBe(0)
  })

  it('has row level security, a select policy for authenticated only, and no client grants beyond select', async () => {
    const { rows: rls } = await db.sql.query<{ rls: boolean }>(
      `select relrowsecurity as rls from pg_class where oid = 'public.reports'::regclass`,
    )
    expect(rls[0]?.rls).toBe(true)
    const { rows: policies } = await db.sql.query<{
      policyname: string
      cmd: string
      roles: string[]
    }>(
      `select policyname, cmd, roles::text[] as roles from pg_policies where schemaname = 'public' and tablename = 'reports' order by policyname`,
    )
    expect(policies).toEqual([
      { policyname: 'reports_select_own', cmd: 'SELECT', roles: ['authenticated'] },
    ])
    const { rows: grants } = await db.sql.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'reports' and grantee in ('anon', 'authenticated') order by 1, 2`,
    )
    expect(grants).toEqual([{ grantee: 'authenticated', privilege_type: 'SELECT' }])
  })
})
