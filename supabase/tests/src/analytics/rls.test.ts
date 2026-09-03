/**
 * Authorization matrix for the analytics tables (ARCHITECTURE §15, spec §114; DB_API §8; 0820):
 * `analytics_events`, `rtc_diagnostics` and `metrics_daily` are service-only — no caller kind
 * reads or writes them through the API roles, whatever their relation to the rows' Human.
 *
 * Actors: visitor, guest, claiming, self (the Human the seeded rows belong to), member (shares a
 * group with self), nonMember, friend, blocked (blocked by self), plus the service role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  PERMISSION_DENIED,
  addMember,
  attempt,
  befriend,
  block,
  createGroup,
  createGuest,
  createHuman,
  human,
  sqlstate,
  startStandaloneRoom,
  type Human,
} from './fixtures'

const ACTORS = ['visitor', 'guest', 'claiming', 'self', 'member', 'nonMember', 'friend', 'blocked'] as const
type Actor = (typeof ACTORS)[number]

const TABLES = ['analytics_events', 'rtc_diagnostics', 'metrics_daily'] as const
type Table = (typeof TABLES)[number]

const PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const

describe('RLS matrix over the analytics tables (service only)', () => {
  let db: TestDb
  let self: Human
  let actorSpec: Record<Actor, RoleSpec>
  let roomId: string

  const statements = (table: Table, ctx: { humanId: string; roomId: string }): Record<'select' | 'insert' | 'update' | 'delete', string> => {
    switch (table) {
      case 'analytics_events':
        return {
          select: 'select * from public.analytics_events',
          insert: `insert into public.analytics_events (human_id, name, platform, app_version) values ('${ctx.humanId}', 'feed_opened', 'web', '1.0.0')`,
          update: `update public.analytics_events set properties = '{}' where human_id = '${ctx.humanId}'`,
          delete: `delete from public.analytics_events where human_id = '${ctx.humanId}'`,
        }
      case 'rtc_diagnostics':
        return {
          select: 'select * from public.rtc_diagnostics',
          insert: `insert into public.rtc_diagnostics (human_id, room_id, kind) values ('${ctx.humanId}', '${ctx.roomId}', 'connected')`,
          update: `update public.rtc_diagnostics set payload = '{}' where human_id = '${ctx.humanId}'`,
          delete: `delete from public.rtc_diagnostics where human_id = '${ctx.humanId}'`,
        }
      case 'metrics_daily':
        return {
          select: 'select * from public.metrics_daily',
          insert: `insert into public.metrics_daily (day, metric, value) values ('2026-06-16', 'rooms_started', 1)`,
          update: `update public.metrics_daily set value = 0 where metric = 'rooms_started'`,
          delete: `delete from public.metrics_daily where metric = 'rooms_started'`,
        }
    }
  }

  beforeAll(async () => {
    db = await createTestDb()
    self = await human(db, 'Self')
    const member = await human(db, 'Member')
    const nonMember = await human(db, 'NonMember')
    const friend = await human(db, 'Friend')
    const blocked = await human(db, 'Blocked')
    const claiming = await createHuman(db, { handle: 'claiming', status: 'pending', identity: false })
    const guest = await createGuest(db)
    await befriend(db, self, friend)
    await befriend(db, self, blocked)
    await block(db, self, blocked)
    const group = await createGroup(db, self, 'Crew')
    await addMember(db, group, member)
    roomId = (await startStandaloneRoom(db, self, 'Room')).room.id
    actorSpec = {
      visitor: 'visitor',
      guest: guest.as,
      claiming: claiming.as,
      self: self.as,
      member: member.as,
      nonMember: nonMember.as,
      friend: friend.as,
      blocked: blocked.as,
    }
    // Seed one row per table as the service.
    await db.sql.query(
      `insert into public.analytics_events (human_id, name, platform, app_version) values ($1, 'feed_opened', 'web', '1.0.0')`,
      [self.humanId],
    )
    await db.sql.query(`insert into public.rtc_diagnostics (human_id, room_id, kind) values ($1, $2, 'connected')`, [self.humanId, roomId])
    await db.sql.query(`insert into public.metrics_daily (day, metric, value) values ('2026-06-15', 'rooms_started', 1)`)
  })

  afterAll(async () => {
    await db.drop()
  })

  describe.each(TABLES)('public.%s', (table) => {
    it('has RLS enabled, no policy for the API roles and no privilege for anon/authenticated', async () => {
      const { rows: rls } = await db.sql.query<{ rls: boolean }>(
        'select relrowsecurity as rls from pg_class where oid = $1::regclass',
        [`public.${table}`],
      )
      expect(rls[0]?.rls).toBe(true)
      const { rows: policies } = await db.sql.query<{ n: number }>(
        `select count(*)::int as n from pg_policies where schemaname = 'public' and tablename = $1`,
        [table],
      )
      expect(policies[0]?.n).toBe(0)
      for (const role of ['anon', 'authenticated', 'public']) {
        for (const privilege of PRIVILEGES) {
          const { rows } = await db.sql.query<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', [role, `public.${table}`, privilege])
          expect(rows[0]?.ok, `${role} ${privilege}`).toBe(false)
        }
      }
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const { rows } = await db.sql.query<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', ['service_role', `public.${table}`, privilege])
        expect(rows[0]?.ok, `service_role ${privilege}`).toBe(true)
      }
    })

    it.each(ACTORS)('%s cannot select, insert, update or delete', async (actor) => {
      const sql = statements(table, { humanId: self.humanId, roomId })
      for (const op of ['select', 'insert', 'update', 'delete'] as const) {
        expect(sqlstate(await attempt(db, actorSpec[actor], sql[op])), `${actor} ${op}`).toBe(PERMISSION_DENIED)
      }
    })

    it('the service role reads and writes', async () => {
      const sql = statements(table, { humanId: self.humanId, roomId })
      const seen = await db.asRole('service', async (client) => (await client.query(sql.select)).rowCount)
      expect(seen).toBe(1)
      for (const op of ['insert', 'update', 'delete'] as const) {
        expect(await attempt(db, 'service', sql[op]), op).toBeUndefined()
      }
    })
  })

  it('rooms.max_visibility is readable with the room and never client-writable', async () => {
    const visible = await db.asRole(self.as, async (client) => {
      const { rows } = await client.query<{ max_visibility: string }>('select max_visibility::text from public.rooms where id = $1', [roomId])
      return rows[0]?.max_visibility
    })
    expect(visible).toBe('friends')
    for (const actor of ACTORS) {
      expect(sqlstate(await attempt(db, actorSpec[actor], `update public.rooms set max_visibility = 'world' where id = '${roomId}'`)), actor).toBe(PERMISSION_DENIED)
    }
  })
})
