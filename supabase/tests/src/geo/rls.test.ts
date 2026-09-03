/**
 * Authorization matrix for the geo tables (ARCHITECTURE §15, spec §114; DB_API §5): what each
 * caller kind can select, insert, update and delete on areas, places, location_shares and
 * location_share_positions through the API roles.
 *
 * Actors: visitor, guest, claiming (pending Human), self (the sharer), other (unrelated Human),
 * friend (audience of self's friend share), blocked (blocked by self), member (member of self's
 * group, audience of the group share). Recipients never read shares from the tables — only through
 * location_shares_visible() — so even the audience sees zero rows here.
 */
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  BASE_AREA_SLUGS,
  addMember,
  areaBySlug,
  befriend,
  block,
  count,
  createGroup,
  createGuest,
  createHuman,
  createShare,
  human,
  type Human,
} from './fixtures'

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

/** `denied` = no privilege (42501); `rls` = privilege but the row policy refused; `ok` = written. */
type WriteOutcome = 'denied' | 'rls' | 'ok'
type CountOutcome = 'denied' | number

interface TableCase {
  table: string
  select: Record<Actor, CountOutcome>
  insert: { sql: () => string; expect: Record<Actor, WriteOutcome> }
  update: { sql: () => string; expect: Record<Actor, CountOutcome> }
  delete: { sql: () => string; expect: Record<Actor, CountOutcome> }
}

const all = <T>(value: T): Record<Actor, T> =>
  Object.fromEntries(ACTORS.map((a) => [a, value])) as Record<Actor, T>

function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

describe('RLS matrix over the geo tables', () => {
  let db: TestDb
  let actorSpec: Record<Actor, RoleSpec>
  let self: Human
  let mission: string
  let areaCount: number
  let placeCount: number
  let shareIds: string[]

  beforeAll(async () => {
    db = await createTestDb()
    self = await human(db, 'Self')
    const other = await human(db, 'Other')
    const friend = await human(db, 'Friend')
    const blocked = await human(db, 'Blocked')
    const member = await human(db, 'Member')
    const claiming = await createHuman(db, { handle: 'claiming', status: 'pending' })
    const guest = await createGuest(db)
    await befriend(db, self, friend)
    await befriend(db, self, blocked)
    await block(db, self, blocked)
    const group = await createGroup(db, self, 'Crew')
    await addMember(db, group, member)
    mission = await areaBySlug(db, BASE_AREA_SLUGS.mission)

    const toFriend = await createShare(db, self, {
      audienceId: friend.humanId,
      precision: 'precise',
    })
    const toGroup = await createShare(db, self, {
      audienceType: 'group',
      audienceId: group.groupId,
      precision: 'city',
    })
    shareIds = [toFriend.id, toGroup.id]
    // A share by someone else, so "self" really only sees their own.
    await befriend(db, other, friend)
    await createShare(db, other, { audienceId: friend.humanId, precision: 'approximate' })

    areaCount = await count(db, 'public.areas')
    placeCount = await count(db, 'public.places')
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

  const cases = (): TableCase[] => [
    {
      table: 'areas',
      select: all(areaCount),
      insert: {
        sql: () =>
          `insert into public.areas (type, name, slug, centroid) values ('city', 'X', 'probe-x', st_setsrid(st_makepoint(0, 0), 4326))`,
        expect: all('denied'),
      },
      update: { sql: () => `update public.areas set name = 'x'`, expect: all('denied') },
      delete: { sql: () => `delete from public.areas`, expect: all('denied') },
    },
    {
      table: 'places',
      select: all(placeCount),
      insert: {
        sql: () =>
          `insert into public.places (name, area_id, location) values ('X', ${q(mission)}, st_setsrid(st_makepoint(0, 0), 4326))`,
        expect: all('denied'),
      },
      update: { sql: () => `update public.places set name = 'x'`, expect: all('denied') },
      delete: { sql: () => `delete from public.places`, expect: all('denied') },
    },
    {
      table: 'location_shares',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 2,
        other: 1,
        friend: 0,
        blocked: 0,
        member: 0,
      },
      insert: {
        sql: () =>
          `insert into public.location_shares (human_id, audience_type, audience_id, precision, expires_at) values (${q(self.humanId)}, 'friend', gen_random_uuid(), 'city', now() + interval '1 hour')`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.location_shares set revoked_at = now()`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.location_shares`, expect: all('denied') },
    },
    {
      table: 'location_share_positions',
      select: all('denied'),
      insert: {
        sql: () =>
          `insert into public.location_share_positions (share_id, location) values (${q(shareIds[0] ?? '')}, st_setsrid(st_makepoint(0, 0), 4326))`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.location_share_positions set updated_at = now()`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.location_share_positions`, expect: all('denied') },
    },
  ]

  for (const tableName of ['areas', 'places', 'location_shares', 'location_share_positions']) {
    describe(`public.${tableName}`, () => {
      const tableCase = (): TableCase => {
        const found = cases().find((c) => c.table === tableName)
        if (found === undefined) throw new Error(`no case for ${tableName}`)
        return found
      }

      it('has row level security enabled', async () => {
        const { rows } = await db.sql.query<{ rls: boolean }>(
          'select relrowsecurity as rls from pg_class where oid = $1::regclass',
          [`public.${tableName}`],
        )
        expect(rows[0]?.rls).toBe(true)
      })

      for (const actor of ACTORS) {
        it(`select as ${actor}`, async () => {
          const outcome = await run(actor, `select * from public.${tableName}`)
          const expected = tableCase().select[actor]
          if (expected === 'denied') expect(outcome.kind).toBe('denied')
          else expect(outcome).toEqual({ kind: 'ok', rows: expected })
        })
        it(`insert as ${actor}`, async () => {
          const spec = tableCase().insert
          expect((await run(actor, spec.sql())).kind).toBe(spec.expect[actor])
        })
        it(`update as ${actor}`, async () => {
          const spec = tableCase().update
          const outcome = await run(actor, spec.sql())
          const expected = spec.expect[actor]
          if (expected === 'denied') expect(outcome.kind).toBe('denied')
          else expect(outcome).toEqual({ kind: 'ok', rows: expected })
        })
        it(`delete as ${actor}`, async () => {
          const spec = tableCase().delete
          const outcome = await run(actor, spec.sql())
          const expected = spec.expect[actor]
          if (expected === 'denied') expect(outcome.kind).toBe('denied')
          else expect(outcome).toEqual({ kind: 'ok', rows: expected })
        })
      }
    })
  }

  it('the sharer reads only their own shares and never a position row', async () => {
    const own = await db.asRole(actorSpec.self, (c) =>
      c.query('select id from public.location_shares order by created_at'),
    )
    expect(own.rows.map((r) => (r as { id: string }).id).sort()).toEqual([...shareIds].sort())
    const denied = await run('self', 'select * from public.location_share_positions')
    expect(denied.kind).toBe('denied')
  })

  it('service_role bypasses the policies for sweeps and support tooling', async () => {
    const shares = await db.asRole('service', (c) =>
      c.query('select count(*)::int as n from public.location_shares'),
    )
    expect((shares.rows[0] as { n: number }).n).toBe(3)
    const positions = await db.asRole('service', (c) =>
      c.query('select count(*)::int as n from public.location_share_positions'),
    )
    expect((positions.rows[0] as { n: number }).n).toBe(3)
  })
})
