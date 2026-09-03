/**
 * Authorization matrix (ARCHITECTURE §15, spec §114): for every table created by the admission
 * migrations, what each caller kind can select, insert, update and delete through the API roles.
 *
 * Actors: visitor, guest, claiming (pending Human with identity), self (the Human owning the seeded
 * rows), other (unrelated Human), friend, blocked (blocked by self), member (shares a group with
 * self, also a non-member of everything else), plus the service role for the private tables.
 * Every mutation runs in a rolled-back transaction so the seed stays intact.
 */
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  addMember,
  befriend,
  block,
  createArea,
  createGroup,
  createGuest,
  createHuman,
  createInvite,
  relate,
  type GroupFixture,
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
/** `denied`, or the number of rows the actor sees / affects. */
type CountOutcome = 'denied' | number

interface TableCase {
  table: string
  select: Record<Actor, CountOutcome>
  /** SQL producing the row to insert for an actor; `null` when nobody may insert. */
  /** Optional select statement (default `select * from public.<table>`) for tables with seeded base rows. */
  selectSql?: (ctx: Context) => string
  insert?: { sql: (ctx: Context) => string; expect: Record<Actor, WriteOutcome> }
  update?: { sql: (ctx: Context) => string; expect: Record<Actor, CountOutcome> }
  delete?: { sql: (ctx: Context) => string; expect: Record<Actor, CountOutcome> }
}

interface Context {
  humans: Record<Exclude<Actor, 'visitor' | 'guest'>, Human>
  group: GroupFixture
  dm: string
  area: string
}

const all = <T>(value: T): Record<Actor, T> =>
  Object.fromEntries(ACTORS.map((a) => [a, value])) as Record<Actor, T>

function q(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

describe('RLS matrix over every admission table', () => {
  let db: TestDb
  let ctx: Context
  let actorSpec: Record<Actor, RoleSpec>

  beforeAll(async () => {
    db = await createTestDb()
    const self = await createHuman(db, { handle: 'self', displayName: 'Self' })
    const other = await createHuman(db, { handle: 'other', displayName: 'Other' })
    const friend = await createHuman(db, { handle: 'friend', displayName: 'Friend' })
    const blocked = await createHuman(db, { handle: 'blocked', displayName: 'Blocked' })
    const member = await createHuman(db, { handle: 'member', displayName: 'Member' })
    const claiming = await createHuman(db, { handle: 'claiming', status: 'pending' })
    const hidden = await createHuman(db, { handle: 'hidden', visibility: 'hidden' })
    await createHuman(db, { handle: 'limited', visibility: 'limited' })
    const guest = await createGuest(db)
    await befriend(db, self, friend)
    await befriend(db, self, hidden)
    await block(db, self, blocked)
    await relate(db, self, other, 'follow')
    await relate(db, other, self, 'familiar_private')
    await relate(db, member, self, 'friend_pending')

    const group = await createGroup(db, self, 'Crew')
    await addMember(db, group, member)
    await createInvite(db, group, member)
    const dm = (
      await db.rpc<{ id: string }>(
        'conversation_direct_get_or_create',
        { other_human_id: friend.humanId },
        self.as,
      )
    ).id
    const area = await createArea(db, { name: 'San Francisco', slug: 'sf', type: 'city' })
    await db.sql.query(
      `insert into public.places (name, area_id, location) values ('Dolores Park', $1, st_setsrid(st_makepoint(-122.427, 37.7596), 4326))`,
      [area],
    )
    await db.sql.query(
      `insert into public.media_objects (owner_human_id, bucket, storage_key, content_type) values
         ($1, 'avatars', 'self/a.jpg', 'image/jpeg'), ($1, 'media', 'self/m.jpg', 'image/jpeg'), ($2, 'media', 'other/m.jpg', 'image/jpeg')`,
      [self.humanId, other.humanId],
    )
    await db.sql.query(
      `insert into public.human_passes (human_id, provider, status) values ($1, 'mock', 'verified')`,
      [self.humanId],
    )
    await db.sql.query(
      `insert into private.human_pass_metadata (human_pass_id, metadata) select id, '{"k": 1}' from public.human_passes where human_id = $1`,
      [self.humanId],
    )
    await db.sql.query(`insert into public.identity_reviews (human_id, kind) values ($1, 'help')`, [
      self.humanId,
    ])
    await db.sql.query(`insert into public.human_presence (human_id) values ($1)`, [self.humanId])
    await db.sql.query(
      `insert into public.human_context (human_id, home_city_id) values ($1, $2)`,
      [self.humanId, area],
    )
    await db.sql.query(
      `insert into public.push_tokens (human_id, token, platform) values ($1, 'tok', 'ios')`,
      [self.humanId],
    )
    await db.sql.query(
      `insert into public.notifications (recipient_human_id, type, actor_human_id, object_type, object_id, priority) values ($1, 'follow', $2, 'human', $2, 'low')`,
      [self.humanId, other.humanId],
    )
    await db.sql.query(
      `insert into public.notification_cooldowns (recipient_human_id, room_id) values ($1, gen_random_uuid())`,
      [self.humanId],
    )
    await db.sql.query("select earth.audit('seed', 'human', null)")

    ctx = { humans: { claiming, self, other, friend, blocked, member }, group, dm, area }
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

  const cases: TableCase[] = [
    {
      table: 'humans',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 1,
        self: 1,
        other: 1,
        friend: 1,
        blocked: 1,
        member: 1,
      },
      insert: {
        sql: () => `insert into public.humans (status) values ('pending')`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.humans set last_active_at = now()`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.humans`, expect: all('denied') },
    },
    {
      table: 'public_identities',
      // public: self, other, friend, blocked, member (5); limited needs a Human viewer; hidden needs friendship; claiming is pending.
      select: {
        visitor: 5,
        guest: 5,
        claiming: 6,
        self: 6,
        other: 6,
        friend: 6,
        blocked: 5,
        member: 6,
      },
      insert: {
        sql: (c) =>
          `insert into public.public_identities (human_id, display_name, handle) values (${q(c.humans.other.humanId)}, 'x', 'newhandle')`,
        expect: all('denied'),
      },
      update: {
        sql: (c) =>
          `update public.public_identities set bio = 'edited' where human_id = ${q(c.humans.self.humanId)}`,
        expect: {
          visitor: 'denied',
          guest: 0,
          claiming: 0,
          self: 1,
          other: 0,
          friend: 0,
          blocked: 0,
          member: 0,
        },
      },
      delete: { sql: () => `delete from public.public_identities`, expect: all('denied') },
    },
    {
      table: 'media_objects',
      select: {
        visitor: 1,
        guest: 1,
        claiming: 1,
        self: 2,
        other: 2,
        friend: 1,
        blocked: 1,
        member: 1,
      },
      insert: {
        sql: () =>
          `insert into public.media_objects (owner_human_id, bucket, storage_key, content_type) values (earth_current_human_id_placeholder, 'media', 'new/x.jpg', 'image/jpeg')`,
        expect: {
          visitor: 'denied',
          guest: 'rls',
          claiming: 'ok',
          self: 'ok',
          other: 'ok',
          friend: 'ok',
          blocked: 'ok',
          member: 'ok',
        },
      },
      update: { sql: () => `update public.media_objects set width = 1`, expect: all('denied') },
      delete: { sql: () => `delete from public.media_objects`, expect: all('denied') },
    },
    {
      table: 'auth_identities',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 1,
        self: 1,
        other: 1,
        friend: 1,
        blocked: 1,
        member: 1,
      },
      insert: {
        sql: (c) =>
          `insert into public.auth_identities (human_id, provider, provider_subject) values (${q(c.humans.self.humanId)}, 'email', 'x@y')`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.auth_identities set revoked_at = now()`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.auth_identities`, expect: all('denied') },
    },
    {
      table: 'human_passes',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 1,
        other: 0,
        friend: 0,
        blocked: 0,
        member: 0,
      },
      insert: {
        sql: (c) =>
          `insert into public.human_passes (human_id, provider) values (${q(c.humans.other.humanId)}, 'mock')`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.human_passes set status = 'verified'`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.human_passes`, expect: all('denied') },
    },
    {
      table: 'identity_reviews',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 1,
        other: 0,
        friend: 0,
        blocked: 0,
        member: 0,
      },
      insert: {
        sql: (c) =>
          `insert into public.identity_reviews (human_id, kind) values (${q(c.humans.self.humanId)}, 'help')`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.identity_reviews set status = 'approved', resolved_at = now()`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.identity_reviews`, expect: all('denied') },
    },
    {
      table: 'relationships',
      // self as source: friend, friend(hidden), follow (3); as target: friend, friend(hidden), pending (3); familiar_private hidden = 6.
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 6,
        other: 2,
        friend: 2,
        blocked: 0,
        member: 1,
      },
      insert: {
        sql: (c) =>
          `insert into public.relationships (source_human_id, target_human_id, type) values (${q(c.humans.self.humanId)}, ${q(c.humans.member.humanId)}, 'follow')`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.relationships set type = 'friend'`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.relationships`, expect: all('denied') },
    },
    {
      table: 'blocks',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 1,
        other: 0,
        friend: 0,
        blocked: 0,
        member: 0,
      },
      insert: {
        sql: (c) =>
          `insert into public.blocks (blocker_human_id, blocked_human_id) values (${q(c.humans.self.humanId)}, ${q(c.humans.other.humanId)})`,
        expect: all('denied'),
      },
      update: { sql: () => `update public.blocks set created_at = now()`, expect: all('denied') },
      delete: { sql: () => `delete from public.blocks`, expect: all('denied') },
    },
    {
      table: 'human_presence',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 1,
        other: 0,
        friend: 0,
        blocked: 0,
        member: 0,
      },
      insert: {
        sql: () =>
          `insert into public.human_presence (human_id) values (earth_current_human_placeholder) on conflict (human_id) do update set last_active_at = now()`,
        expect: {
          visitor: 'denied',
          guest: 'rls',
          claiming: 'rls',
          self: 'ok',
          other: 'ok',
          friend: 'ok',
          blocked: 'ok',
          member: 'ok',
        },
      },
      update: {
        sql: () => `update public.human_presence set platform = 'web'`,
        expect: {
          visitor: 'denied',
          guest: 0,
          claiming: 0,
          self: 1,
          other: 0,
          friend: 0,
          blocked: 0,
          member: 0,
        },
      },
      delete: {
        sql: () => `delete from public.human_presence`,
        expect: {
          visitor: 'denied',
          guest: 0,
          claiming: 0,
          self: 1,
          other: 0,
          friend: 0,
          blocked: 0,
          member: 0,
        },
      },
    },
    {
      table: 'human_context',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 1,
        other: 0,
        friend: 0,
        blocked: 0,
        member: 0,
      },
      insert: {
        sql: () =>
          `insert into public.human_context (human_id) values (earth_current_human_placeholder) on conflict (human_id) do update set updated_at = now()`,
        expect: {
          visitor: 'denied',
          guest: 'rls',
          claiming: 'rls',
          self: 'ok',
          other: 'ok',
          friend: 'ok',
          blocked: 'ok',
          member: 'ok',
        },
      },
      update: {
        sql: () => `update public.human_context set last_scope_home = 'city'`,
        expect: {
          visitor: 'denied',
          guest: 0,
          claiming: 0,
          self: 1,
          other: 0,
          friend: 0,
          blocked: 0,
          member: 0,
        },
      },
      delete: {
        sql: () => `delete from public.human_context`,
        expect: {
          visitor: 'denied',
          guest: 0,
          claiming: 0,
          self: 1,
          other: 0,
          friend: 0,
          blocked: 0,
          member: 0,
        },
      },
    },
    {
      table: 'push_tokens',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 1,
        other: 0,
        friend: 0,
        blocked: 0,
        member: 0,
      },
      insert: {
        sql: () =>
          `insert into public.push_tokens (human_id, token, platform) values (earth_current_human_placeholder, 'new', 'web')`,
        expect: {
          visitor: 'denied',
          guest: 'rls',
          claiming: 'rls',
          self: 'ok',
          other: 'ok',
          friend: 'ok',
          blocked: 'ok',
          member: 'ok',
        },
      },
      update: {
        sql: () => `update public.push_tokens set platform = 'web'`,
        expect: {
          visitor: 'denied',
          guest: 0,
          claiming: 0,
          self: 1,
          other: 0,
          friend: 0,
          blocked: 0,
          member: 0,
        },
      },
      delete: {
        sql: () => `delete from public.push_tokens`,
        expect: {
          visitor: 'denied',
          guest: 0,
          claiming: 0,
          self: 1,
          other: 0,
          friend: 0,
          blocked: 0,
          member: 0,
        },
      },
    },
    {
      table: 'groups',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 1,
        other: 0,
        friend: 0,
        blocked: 0,
        member: 1,
      },
      insert: {
        sql: (c) =>
          `insert into public.groups (created_by_human_id) values (${q(c.humans.self.humanId)})`,
        expect: all('denied'),
      },
      update: { sql: () => `update public.groups set name = 'x'`, expect: all('denied') },
      delete: { sql: () => `delete from public.groups`, expect: all('denied') },
    },
    {
      table: 'group_members',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 2,
        other: 0,
        friend: 0,
        blocked: 0,
        member: 2,
      },
      insert: {
        sql: (c) =>
          `insert into public.group_members (group_id, human_id) values (${q(c.group.groupId)}, ${q(c.humans.other.humanId)})`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.group_members set role = 'owner'`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.group_members`, expect: all('denied') },
    },
    {
      table: 'group_invites',
      select: all('denied'),
      insert: {
        sql: (c) =>
          `insert into public.group_invites (group_id, created_by, token_hash) values (${q(c.group.groupId)}, ${q(c.humans.self.humanId)}, repeat('a', 64))`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.group_invites set status = 'revoked'`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.group_invites`, expect: all('denied') },
    },
    {
      table: 'group_invites_view',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 1,
        other: 0,
        friend: 0,
        blocked: 0,
        member: 1,
      },
    },
    {
      table: 'conversations',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 2,
        other: 0,
        friend: 1,
        blocked: 0,
        member: 1,
      },
      insert: {
        sql: () => `insert into public.conversations (type, direct_key) values ('direct', 'a:b')`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.conversations set last_message_at = now()`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.conversations`, expect: all('denied') },
    },
    {
      table: 'conversation_members',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 4,
        other: 0,
        friend: 2,
        blocked: 0,
        member: 2,
      },
      insert: {
        sql: (c) =>
          `insert into public.conversation_members (conversation_id, human_id) values (${q(c.dm)}, ${q(c.humans.other.humanId)})`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.conversation_members set mute_state = 'muted'`,
        expect: {
          visitor: 'denied',
          guest: 0,
          claiming: 0,
          self: 2,
          other: 0,
          friend: 1,
          blocked: 0,
          member: 1,
        },
      },
      delete: { sql: () => `delete from public.conversation_members`, expect: all('denied') },
    },
    {
      table: 'notifications',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 1,
        other: 0,
        friend: 0,
        blocked: 0,
        member: 0,
      },
      insert: {
        sql: (c) =>
          `insert into public.notifications (recipient_human_id, type, object_type, object_id, priority) values (${q(c.humans.self.humanId)}, 'follow', 'human', ${q(c.humans.self.humanId)}, 'low')`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.notifications set read_at = now()`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.notifications`, expect: all('denied') },
    },
    {
      table: 'notification_cooldowns',
      select: all('denied'),
      insert: {
        sql: (c) =>
          `insert into public.notification_cooldowns (recipient_human_id, room_id) values (${q(c.humans.self.humanId)}, gen_random_uuid())`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.notification_cooldowns set sends_in_window = 2`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.notification_cooldowns`, expect: all('denied') },
    },
    {
      table: 'feature_flags',
      select: all(11),
      insert: {
        sql: () => `insert into public.feature_flags (key) values ('NEW_FLAG')`,
        expect: all('denied'),
      },
      update: {
        sql: () => `update public.feature_flags set enabled = false`,
        expect: all('denied'),
      },
      delete: { sql: () => `delete from public.feature_flags`, expect: all('denied') },
    },
    {
      table: 'app_settings',
      select: all(4),
      insert: {
        sql: () => `insert into public.app_settings (key, value) values ('new_key', 'x')`,
        expect: all('denied'),
      },
      update: { sql: () => `update public.app_settings set value = 'x'`, expect: all('denied') },
      delete: { sql: () => `delete from public.app_settings`, expect: all('denied') },
    },
    {
      table: 'areas',
      // Base areas are seeded by 0510, so count only the fixture's own row.
      select: all(1),
      selectSql: (c) => `select id from public.areas where id = ${q(c.area)}`,
      insert: {
        sql: () =>
          `insert into public.areas (type, name, slug, centroid) values ('city', 'X', 'x', st_setsrid(st_makepoint(0, 0), 4326))`,
        expect: all('denied'),
      },
      update: { sql: () => `update public.areas set name = 'x'`, expect: all('denied') },
      delete: { sql: () => `delete from public.areas`, expect: all('denied') },
    },
    {
      table: 'places',
      select: all(1),
      selectSql: (c) => `select id from public.places where area_id = ${q(c.area)}`,
      insert: {
        sql: (c) =>
          `insert into public.places (name, area_id, location) values ('X', ${q(c.area)}, st_setsrid(st_makepoint(0, 0), 4326))`,
        expect: all('denied'),
      },
      update: { sql: () => `update public.places set name = 'x'`, expect: all('denied') },
      delete: { sql: () => `delete from public.places`, expect: all('denied') },
    },
  ]

  /** Replaces the placeholders with the acting Human's id (the RPC-free way to write "me"). */
  function bind(actor: Actor, sql: string): string {
    const human = actor === 'visitor' || actor === 'guest' ? null : ctx.humans[actor].humanId
    return sql
      .replaceAll('earth_current_human_id_placeholder', human === null ? 'null' : q(human))
      .replaceAll('earth_current_human_placeholder', human === null ? 'null' : q(human))
  }

  for (const tableCase of cases) {
    describe(`public.${tableCase.table}`, () => {
      it('has row level security enabled (tables)', async () => {
        const { rows } = await db.sql.query<{ relkind: string; rls: boolean }>(
          'select relkind, relrowsecurity as rls from pg_class where oid = $1::regclass',
          [`public.${tableCase.table}`],
        )
        if (rows[0]?.relkind === 'r') expect(rows[0]?.rls).toBe(true)
      })

      for (const actor of ACTORS) {
        it(`select as ${actor}`, async () => {
          const outcome = await run(
            actor,
            tableCase.selectSql === undefined
              ? `select * from public.${tableCase.table}`
              : bind(actor, tableCase.selectSql(ctx)),
          )
          const expected = tableCase.select[actor]
          if (expected === 'denied') expect(outcome.kind).toBe('denied')
          else expect(outcome).toEqual({ kind: 'ok', rows: expected })
        })

        if (tableCase.insert !== undefined) {
          const spec = tableCase.insert
          it(`insert as ${actor}`, async () => {
            const outcome = await run(actor, bind(actor, spec.sql(ctx)))
            expect(outcome.kind).toBe(spec.expect[actor])
          })
        }
        if (tableCase.update !== undefined) {
          const spec = tableCase.update
          it(`update as ${actor}`, async () => {
            const outcome = await run(actor, bind(actor, spec.sql(ctx)))
            const expected = spec.expect[actor]
            if (expected === 'denied') expect(outcome.kind).toBe('denied')
            else expect(outcome).toEqual({ kind: 'ok', rows: expected })
          })
        }
        if (tableCase.delete !== undefined) {
          const spec = tableCase.delete
          it(`delete as ${actor}`, async () => {
            const outcome = await run(actor, bind(actor, spec.sql(ctx)))
            const expected = spec.expect[actor]
            if (expected === 'denied') expect(outcome.kind).toBe('denied')
            else expect(outcome).toEqual({ kind: 'ok', rows: expected })
          })
        }
      }
    })
  }

  describe('private schema', () => {
    for (const table of [
      'private.human_pass_metadata',
      'private.audit_log',
      'private.rate_limits',
    ]) {
      it(`${table} is closed to every API role`, async () => {
        for (const role of ['anon', 'authenticated', 'service_role', 'public']) {
          for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            const { rows } = await db.sql.query<{ ok: boolean }>(
              'select has_table_privilege($1, $2, $3) as ok',
              [role, table, privilege],
            )
            expect(rows[0]?.ok, `${role} ${privilege} on ${table}`).toBe(false)
          }
        }
        for (const actor of ACTORS) {
          expect((await run(actor, `select * from ${table}`)).kind).toBe('denied')
        }
      })
    }
  })

  it('claiming Humans see their own identity row but never appear to others', async () => {
    const visible = await db.asRole(actorSpec.other, (c) =>
      c.query('select handle from public.public_identities where human_id = $1', [
        ctx.humans.claiming.humanId,
      ]),
    )
    expect(visible.rowCount).toBe(0)
    const own = await db.asRole(actorSpec.claiming, (c) =>
      c.query('select handle from public.public_identities where human_id = $1', [
        ctx.humans.claiming.humanId,
      ]),
    )
    expect(own.rowCount).toBe(1)
  })
})
