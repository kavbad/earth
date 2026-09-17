/**
 * Authorization matrix for the room tables (ARCHITECTURE §15, spec §114; DB_API §3 "RLS summary"):
 * what each caller kind can select, insert, update and delete through the API roles.
 *
 * Actors: visitor, guest1 (Guest of room R1), guest2 (Guest of room R2), claiming (pending Human),
 * self (moderator of R1), other (initiator of R2, stranger to R1), friend (friend of self),
 * blocked (blocked by self), member (member of self's group, watching in R1).
 * R1: group room of self's group, opened to friends; R2: standalone room of `other`, opened to world.
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
  createRoomInvite,
  human,
  joinRoom,
  startGroupRoom,
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
] as const
type Actor = (typeof ACTORS)[number]

type WriteOutcome = 'denied' | 'rls' | 'ok'
type CountOutcome = 'denied' | number

interface Relation {
  relation: string
  select: Record<Actor, CountOutcome>
  insert?: { sql: string; expect: Record<Actor, WriteOutcome> }
  update?: { sql: string; expect: Record<Actor, CountOutcome> }
  delete?: { sql: string; expect: Record<Actor, CountOutcome> }
}

const all = <T>(value: T): Record<Actor, T> =>
  Object.fromEntries(ACTORS.map((a) => [a, value])) as Record<Actor, T>

describe('RLS matrix over the room tables', () => {
  let db: TestDb
  let actorSpec: Record<Actor, RoleSpec>
  let self: Human
  let other: Human
  let r1: string
  let r2: string
  let guest1SessionId: string

  beforeAll(async () => {
    db = await createTestDb()
    self = await human(db, 'Self')
    other = await human(db, 'Other')
    const friend = await human(db, 'Friend')
    const blocked = await human(db, 'Blocked')
    const member = await human(db, 'Member')
    const claiming = await createHuman(db, { handle: 'claiming', status: 'pending' })
    await befriend(db, self, friend)
    await befriend(db, self, blocked)
    await block(db, self, blocked)
    const group = await createGroup(db, self, 'Crew')
    await addMember(db, group, member)

    const started = await startGroupRoom(db, self, group)
    r1 = started.room.id
    await joinRoom(db, r1, member, 'watching')
    await db.rpc('room_set_visibility', { room_id: r1, visibility: 'friends' }, self.as)
    const invite1 = await createRoomInvite(db, r1, self)
    const guest1 = await createGuest(db)
    guest1SessionId = (await createGuestSession(db, guest1, invite1.token, 'Sam')).guestSessionId

    const standalone = await startStandaloneRoom(db, other)
    r2 = standalone.room.id
    await db.rpc('room_set_visibility', { room_id: r2, visibility: 'world' }, other.as)
    const invite2 = await createRoomInvite(db, r2, other)
    const guest2 = await createGuest(db)
    await createGuestSession(db, guest2, invite2.token, 'Pat')

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

  const relations = (): Relation[] => [
    {
      relation: 'rooms',
      // R1 (friends): self, member, friend, guest1. R2 (world): everyone but guest1 (guests see only their room).
      select: {
        visitor: 1,
        guest1: 1,
        guest2: 1,
        claiming: 1,
        self: 2,
        other: 1,
        friend: 2,
        blocked: 1,
        member: 2,
      },
      insert: {
        sql: `insert into public.rooms (context_type, initiated_by_human_id, visibility, join_policy) values ('standalone', '${self.humanId}', 'friends', 'friends')`,
        expect: all('denied'),
      },
      update: { sql: `update public.rooms set title = 'x'`, expect: all('denied') },
      delete: { sql: `delete from public.rooms`, expect: all('denied') },
    },
    {
      relation: 'room_participants',
      // R1 rows: self (camera), member (watching), guest1 (audio). R2 rows: other (camera), guest2 (audio).
      // Inside R1 (self, member, guest1) see all 3; friend sees the 2 publishers; watchers stay hidden outward.
      select: {
        visitor: 2,
        guest1: 3,
        guest2: 2,
        claiming: 2,
        self: 5,
        other: 2,
        friend: 4,
        blocked: 2,
        member: 5,
      },
      insert: {
        sql: `insert into public.room_participants (room_id, human_id) values ('${r1}', '${self.humanId}')`,
        expect: all('denied'),
      },
      update: {
        sql: `update public.room_participants set media_state = 'camera'`,
        expect: all('denied'),
      },
      delete: { sql: `delete from public.room_participants`, expect: all('denied') },
    },
    {
      relation: 'guest_sessions',
      select: all('denied'),
      insert: {
        sql: `insert into public.guest_sessions (room_id, display_name, session_secret_hash, expires_at) values ('${r1}', 'x', repeat('a', 64), now() + interval '1 hour')`,
        expect: all('denied'),
      },
      update: { sql: `update public.guest_sessions set display_name = 'x'`, expect: all('denied') },
      delete: { sql: `delete from public.guest_sessions`, expect: all('denied') },
    },
    {
      relation: 'guest_sessions_view',
      // Own session for guests; moderators see the sessions of their room.
      select: {
        visitor: 'denied',
        guest1: 1,
        guest2: 1,
        claiming: 0,
        self: 1,
        other: 1,
        friend: 0,
        blocked: 0,
        member: 0,
      },
    },
    {
      relation: 'room_invites',
      select: all('denied'),
      insert: {
        sql: `insert into public.room_invites (room_id, token_hash, created_by_human_id, expires_at) values ('${r1}', repeat('b', 64), '${self.humanId}', now() + interval '1 hour')`,
        expect: all('denied'),
      },
      update: {
        sql: `update public.room_invites set status = 'revoked', revoked_at = now()`,
        expect: all('denied'),
      },
      delete: { sql: `delete from public.room_invites`, expect: all('denied') },
    },
    {
      relation: 'room_invites_view',
      select: {
        visitor: 'denied',
        guest1: 0,
        guest2: 0,
        claiming: 0,
        self: 1,
        other: 1,
        friend: 0,
        blocked: 0,
        member: 0,
      },
    },
    {
      relation: 'room_blocked_fingerprints',
      select: all('denied'),
      insert: {
        sql: `insert into public.room_blocked_fingerprints (room_id, fingerprint_hash) values ('${r1}', 'fp-12345678')`,
        expect: all('denied'),
      },
      update: {
        sql: `update public.room_blocked_fingerprints set fingerprint_hash = 'x'`,
        expect: all('denied'),
      },
      delete: { sql: `delete from public.room_blocked_fingerprints`, expect: all('denied') },
    },
    {
      relation: 'notification_cooldowns',
      select: all('denied'),
      insert: {
        sql: `insert into public.notification_cooldowns (recipient_human_id, room_id) values ('${self.humanId}', '${r2}')`,
        expect: all('denied'),
      },
    },
  ]

  for (const name of [
    'rooms',
    'room_participants',
    'guest_sessions',
    'room_invites',
    'room_blocked_fingerprints',
  ] as const) {
    it(`public.${name} has row level security enabled`, async () => {
      const { rows } = await db.sql.query<{ rls: boolean }>(
        'select relrowsecurity as rls from pg_class where oid = $1::regclass',
        [`public.${name}`],
      )
      expect(rows[0]?.rls).toBe(true)
    })
  }

  it('the views never expose a hash column', async () => {
    for (const view of ['guest_sessions_view', 'room_invites_view']) {
      const { rows } = await db.sql.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = $1`,
        [view],
      )
      expect(
        rows.map((r) => r.column_name).filter((c) => c.includes('hash') || c.includes('secret')),
      ).toEqual([])
    }
  })

  it('guest1 sees exactly their own session and their own room', async () => {
    const rows = await db.asRole(
      actorSpec.guest1,
      async (c) => (await c.query('select id, room_id from public.guest_sessions_view')).rows,
    )
    expect(rows).toEqual([{ id: guest1SessionId, room_id: r1 }])
    const rooms = await db.asRole(
      actorSpec.guest1,
      async (c) => (await c.query('select id from public.rooms')).rows,
    )
    expect(rooms).toEqual([{ id: r1 }])
  })

  describe('matrix', () => {
    for (const actor of ACTORS) {
      it(`select as ${actor}`, async () => {
        for (const rel of relations()) {
          const outcome = await run(actor, `select * from public.${rel.relation}`)
          const expected = rel.select[actor]
          if (expected === 'denied')
            expect(outcome.kind, `${rel.relation} as ${actor}`).toBe('denied')
          else
            expect(outcome, `${rel.relation} as ${actor}`).toEqual({ kind: 'ok', rows: expected })
        }
      })
      it(`writes as ${actor}`, async () => {
        for (const rel of relations()) {
          if (rel.insert !== undefined) {
            expect(
              (await run(actor, rel.insert.sql)).kind,
              `insert ${rel.relation} as ${actor}`,
            ).toBe(rel.insert.expect[actor])
          }
          if (rel.update !== undefined) {
            const outcome = await run(actor, rel.update.sql)
            const expected = rel.update.expect[actor]
            if (expected === 'denied')
              expect(outcome.kind, `update ${rel.relation} as ${actor}`).toBe('denied')
            else
              expect(outcome, `update ${rel.relation} as ${actor}`).toEqual({
                kind: 'ok',
                rows: expected,
              })
          }
          if (rel.delete !== undefined) {
            const outcome = await run(actor, rel.delete.sql)
            const expected = rel.delete.expect[actor]
            if (expected === 'denied')
              expect(outcome.kind, `delete ${rel.relation} as ${actor}`).toBe('denied')
            else
              expect(outcome, `delete ${rel.relation} as ${actor}`).toEqual({
                kind: 'ok',
                rows: expected,
              })
          }
        }
      })
    }
  })

  it('room RPC grants: client RPCs for anon/authenticated, service RPCs for service_role only', async () => {
    const check = async (role: string, fn: string) => {
      const { rows } = await db.sql.query<{ ok: boolean }>(
        'select has_function_privilege($1, $2, $3) as ok',
        [role, fn, 'EXECUTE'],
      )
      return rows[0]?.ok ?? false
    }
    for (const fn of [
      'public.room_get(uuid)',
      'public.room_invite_preview(text)',
      'public.live_candidates(public.audience, uuid, integer)',
    ]) {
      expect(await check('anon', fn), fn).toBe(true)
      expect(await check('authenticated', fn), fn).toBe(true)
    }
    for (const fn of [
      'public.rooms_sweep()',
      'public.room_participant_sync(uuid, text, text, timestamptz)',
    ]) {
      expect(await check('anon', fn), fn).toBe(false)
      expect(await check('authenticated', fn), fn).toBe(false)
      expect(await check('service_role', fn), fn).toBe(true)
    }
    for (const fn of [
      'earth.notify_live(uuid, uuid)',
      'earth.room_end_internal(uuid, text)',
      'earth.room_evaluate_pending_visibility(uuid)',
    ]) {
      expect(await check('anon', fn), fn).toBe(false)
      expect(await check('authenticated', fn), fn).toBe(false)
    }
  })

  it('rooms and room_participants are in the realtime publication with full replica identity', async () => {
    const { rows } = await db.sql.query<{ tablename: string }>(
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename in ('rooms', 'room_participants') order by tablename`,
    )
    expect(rows.map((r) => r.tablename)).toEqual(['room_participants', 'rooms'])
    const identity = await db.sql.query<{ relname: string; relreplident: string }>(
      `select relname, relreplident from pg_class where oid in ('public.rooms'::regclass, 'public.room_participants'::regclass) order by relname`,
    )
    expect(identity.rows).toEqual([
      { relname: 'room_participants', relreplident: 'f' },
      { relname: 'rooms', relreplident: 'f' },
    ])
  })
})
