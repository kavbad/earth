/**
 * The database authorization matrix over EVERY table in schema `public` (ARCHITECTURE §5, §15;
 * spec §114 — launch blocker).
 *
 * `pg_tables` is introspected at run time and the test fails if a base table exists that no
 * expectation entry covers (or an entry names a table that no longer exists), so a new table can
 * never ship without an authorization decision. For each caller kind — visitor, guest, claiming
 * (pending) Human, the Human that owns the seeded rows (`self`), an unrelated Human (`other`), a
 * `friend`, a `blocked` Human, a `member` of self's group and a `nonMember` — the select count and
 * the insert/update/delete outcome are asserted after one minimal world is seeded, mostly through
 * the RPCs (flows) and with a few service-role rows where a raw row is the fastest fixture.
 *
 * Write outcomes: `denied` = 42501 with no privilege at all; `rls` = a granted write the row policy
 * refused; `ok` = written. Tables with no client write path are proven closed structurally (neither
 * `anon` nor `authenticated` holds INSERT/UPDATE/DELETE), which covers all nine callers at once;
 * the own-row tables (presence, context, push tokens, media, identity edits, conversation prefs)
 * run the writes per caller. Every mutation runs in a rolled-back transaction so the seed is stable.
 */
import { randomUUID } from 'node:crypto'

import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  addMember,
  befriend,
  block,
  createGroup,
  createGuest,
  createHuman,
  relate,
  type GroupFixture,
} from '../admission/fixtures'
import { createMedia, createPost } from '../posts/fixtures'

const ACTORS = [
  'visitor',
  'guest',
  'claiming',
  'self',
  'other',
  'friend',
  'blocked',
  'member',
  'nonMember',
] as const
type Actor = (typeof ACTORS)[number]

/** `denied` (42501), `full` (= the whole table, read-all), or the exact visible row count. */
type Count = 'denied' | 'full' | number
type WriteOutcome = 'denied' | 'rls' | 'ok'

interface WriteSpec<E> {
  sql: string
  expect: Record<Actor, E>
}

interface TableCase {
  table: string
  select: Record<Actor, Count>
  /** When all three are omitted, the table is proven closed to client writes structurally. */
  insert?: WriteSpec<WriteOutcome>
  update?: WriteSpec<Count>
  delete?: WriteSpec<Count>
}

/** Ordered record constructor: visitor, guest, claiming, self, other, friend, blocked, member, nonMember. */
function row<E>(v: E, g: E, c: E, s: E, o: E, f: E, b: E, m: E, n: E): Record<Actor, E> {
  return { visitor: v, guest: g, claiming: c, self: s, other: o, friend: f, blocked: b, member: m, nonMember: n }
}
const allDenied = <E>(value: E): Record<Actor, E> =>
  Object.fromEntries(ACTORS.map((a) => [a, value])) as Record<Actor, E>

/** Read-all tables: every caller (visitors included) sees the whole table (0006/0050). */
const READ_ALL = ['areas', 'places', 'feature_flags', 'app_settings'] as const
/** Tables with no client grant at all: every caller is denied every operation. */
const DENIED_ALL = [
  'earth_migrations',
  'analytics_events',
  'metrics_daily',
  'rtc_diagnostics',
  'notification_cooldowns',
  'room_blocked_fingerprints',
  'guest_sessions',
  'room_invites',
  'group_invites',
  'location_share_positions',
] as const

describe('authorization matrix over every public table (spec §114)', () => {
  let db: TestDb
  let actorSpec: Record<Actor, RoleSpec>
  let humanIds: Record<Actor, string | null>
  let fullCounts: Record<string, number>

  beforeAll(async () => {
    db = await createTestDb()

    const self = await createHuman(db, { handle: 'authzself', displayName: 'Self' })
    const other = await createHuman(db, { handle: 'authzother', displayName: 'Other' })
    const friend = await createHuman(db, { handle: 'authzfriend', displayName: 'Friend' })
    const blocked = await createHuman(db, { handle: 'authzblocked', displayName: 'Blocked' })
    const member = await createHuman(db, { handle: 'authzmember', displayName: 'Member' })
    const nonMember = await createHuman(db, { handle: 'authznonmember', displayName: 'NonMember' })
    const claiming = await createHuman(db, { handle: 'authzclaiming', status: 'pending' })
    const guest = await createGuest(db)

    // Social graph: self↔friend (friends), self→other (follow), member→self (friend_pending),
    // self blocks blocked. Direct edges keep the relationship counts exact.
    await befriend(db, self, friend)
    await relate(db, self, other, 'follow')
    await relate(db, member, self, 'friend_pending')

    // Group + its canonical conversation through the RPC; member added directly.
    const group: GroupFixture = await createGroup(db, self, 'Crew')
    await addMember(db, group, member)

    // A direct conversation self↔friend through the RPC.
    const dm = (
      await db.rpc<{ id: string }>('conversation_direct_get_or_create', { other_human_id: friend.humanId }, self.as)
    ).id

    // Messages: two in the group (self, member), one in the DM (self).
    await db.rpc('message_send', { conversation_id: group.conversationId, client_id: randomUUID(), type: 'text', text: 'g1' }, self.as)
    const memberMsg = await db.rpc<{ id: string }>(
      'message_send',
      { conversation_id: group.conversationId, client_id: randomUUID(), type: 'text', text: 'g2' },
      member.as,
    )
    const dmMsg = await db.rpc<{ id: string }>(
      'message_send',
      { conversation_id: dm, client_id: randomUUID(), type: 'text', text: 'hi' },
      self.as,
    )
    // Reactions: self on the member's group message, friend on self's DM message.
    await db.rpc('message_reaction_toggle', { message_id: memberMsg.id, reaction: '❤️' }, self.as)
    await db.rpc('message_reaction_toggle', { message_id: dmMsg.id, reaction: '👍' }, friend.as)

    // Media: a self avatar (public bucket), the media object behind self's world post, an other-owned
    // media object. Avatars are visible to everyone; the rest are owner-only.
    await db.sql.query(
      `insert into public.media_objects (owner_human_id, bucket, storage_key, content_type)
       values ($1, 'avatars', 'authz/self-avatar.jpg', 'image/jpeg'),
              ($2, 'media', 'authz/other-media.jpg', 'image/jpeg')`,
      [self.humanId, other.humanId],
    )
    const postMedia = await createMedia(db, self, { key: 'authz/self-post.jpg' })

    // Posts: self world (with media) + self friends + other world.
    const selfWorld = (await createPost(db, self, { type: 'image', text: 'world', audience: 'world', media: [postMedia] })).post.id
    await createPost(db, self, { text: 'friends', audience: 'friends' })
    const otherWorld = (await createPost(db, other, { text: 'other world', audience: 'world' })).post.id
    // Two reactions on self's world post (both reactors can see it).
    await db.rpc('post_reaction_set', { post_id: selfWorld, reaction_type: 'heart' }, friend.as)
    await db.rpc('post_reaction_set', { post_id: selfWorld, reaction_type: 'heart' }, other.as)
    // A private hide by self.
    await db.rpc('post_hide', { post_id: otherWorld }, self.as)

    // A standalone world room with self publishing on camera (consent world) and member watching.
    // Built as the service so no Live notifications or state-machine widening is involved.
    const roomId = (
      await db.sql.query<{ id: string }>(
        `insert into public.rooms (context_type, initiated_by_human_id, visibility, join_policy, status, started_at)
         values ('standalone', $1, 'world', 'anyone', 'active', now()) returning id`,
        [self.humanId],
      )
    ).rows[0]!.id
    await db.sql.query(
      `insert into public.room_participants (room_id, human_id, role, media_state, status, audience_consent_level, consent_recorded_at)
       values ($1, $2, 'initiator', 'camera', 'active', 'world', now()),
              ($1, $3, 'viewer', 'watching', 'active', 'invited', null)`,
      [roomId, self.humanId, member.humanId],
    )

    // A location share (self → friend) and a report by self.
    await db.rpc(
      'location_share_create',
      { audience_type: 'friend', audience_id: friend.humanId, precision: 'precise', duration_seconds: 3600, lat: 37.8, lng: -122.41 },
      self.as,
    )
    await db.rpc('report_create', { target_type: 'human', target_id: other.humanId, reason: 'harassment', details: null }, self.as)

    // Own-row identity rows for self: a pass, a review, presence, context, a push token.
    await db.sql.query(`insert into public.human_passes (human_id, provider, status) values ($1, 'mock', 'verified')`, [self.humanId])
    await db.sql.query(`insert into public.identity_reviews (human_id, kind) values ($1, 'help')`, [self.humanId])
    await db.sql.query(`insert into public.human_presence (human_id) values ($1)`, [self.humanId])
    await db.sql.query(`insert into public.human_context (human_id) values ($1)`, [self.humanId])
    await db.sql.query(`insert into public.push_tokens (human_id, token, platform) values ($1, 'authz-seed-tok', 'ios')`, [self.humanId])

    // The block goes in last (its trigger only touches shared live rooms; blocked is in none).
    await block(db, self, blocked)

    // Control the notification tables exactly: message_send created a handful of message
    // notifications — clear them and seed one notification whose recipient is self.
    await db.sql.query('delete from public.notifications')
    await db.sql.query('delete from public.notification_cooldowns')
    await db.sql.query(
      `insert into public.notifications (recipient_human_id, type, actor_human_id, object_type, object_id, priority)
       values ($1, 'follow', $2, 'human', $2, 'low')`,
      [self.humanId, other.humanId],
    )
    await db.sql.query('delete from private.rate_limits')

    actorSpec = {
      visitor: 'visitor',
      guest: guest.as,
      claiming: claiming.as,
      self: self.as,
      other: other.as,
      friend: friend.as,
      blocked: blocked.as,
      member: member.as,
      nonMember: nonMember.as,
    }
    humanIds = {
      visitor: null,
      guest: null,
      claiming: claiming.humanId,
      self: self.humanId,
      other: other.humanId,
      friend: friend.humanId,
      blocked: blocked.humanId,
      member: member.humanId,
      nonMember: nonMember.humanId,
    }

    const counts: Record<string, number> = {}
    for (const table of READ_ALL) {
      const { rows } = await db.sql.query<{ n: string }>(`select count(*)::text as n from public.${table}`)
      counts[table] = Number(rows[0]?.n ?? '0')
    }
    fullCounts = counts
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

  function bind(actor: Actor, sql: string): string {
    const me = humanIds[actor]
    const meLit = me === null ? 'null' : `'${me}'`
    const selfLit = `'${humanIds.self}'`
    return sql.replaceAll('$ME$', meLit).replaceAll('$SELF$', selfLit)
  }

  const readAll = row<Count>('full', 'full', 'full', 'full', 'full', 'full', 'full', 'full', 'full')

  const cases: TableCase[] = [
    ...READ_ALL.map((table): TableCase => ({ table, select: readAll })),
    ...DENIED_ALL.map((table): TableCase => ({ table, select: allDenied<Count>('denied') })),

    // -- identity -----------------------------------------------------------------------------------
    { table: 'humans', select: row<Count>('denied', 0, 1, 1, 1, 1, 1, 1, 1) },
    {
      table: 'public_identities',
      // 6 active public identities; the pending one is hidden; self hides blocked and vice versa.
      select: row<Count>(6, 6, 7, 5, 6, 6, 5, 6, 6),
      insert: { sql: `insert into public.public_identities (human_id, display_name, handle) values ($SELF$, 'x', 'authznew')`, expect: allDenied<WriteOutcome>('denied') },
      update: { sql: `update public.public_identities set bio = 'edited' where human_id = $SELF$`, expect: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },
      delete: { sql: `delete from public.public_identities`, expect: allDenied<Count>('denied') },
    },
    {
      table: 'media_objects',
      select: row<Count>(1, 1, 1, 2, 2, 1, 1, 1, 1),
      insert: {
        sql: `insert into public.media_objects (owner_human_id, bucket, storage_key, content_type) values ($ME$, 'media', 'authz/write-probe.jpg', 'image/jpeg')`,
        expect: row<WriteOutcome>('denied', 'rls', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'),
      },
      update: { sql: `update public.media_objects set width = 1`, expect: allDenied<Count>('denied') },
      delete: { sql: `delete from public.media_objects`, expect: allDenied<Count>('denied') },
    },
    { table: 'auth_identities', select: row<Count>('denied', 0, 1, 1, 1, 1, 1, 1, 1) },
    { table: 'human_passes', select: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },
    { table: 'identity_reviews', select: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },
    { table: 'relationships', select: row<Count>('denied', 0, 0, 4, 1, 2, 0, 1, 0) },
    { table: 'blocks', select: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },
    {
      table: 'human_presence',
      select: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0),
      insert: {
        sql: `insert into public.human_presence (human_id) values ($ME$) on conflict (human_id) do update set last_active_at = now()`,
        expect: row<WriteOutcome>('denied', 'rls', 'rls', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'),
      },
      update: { sql: `update public.human_presence set platform = 'web'`, expect: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },
      delete: { sql: `delete from public.human_presence`, expect: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },
    },
    {
      table: 'human_context',
      select: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0),
      insert: {
        sql: `insert into public.human_context (human_id) values ($ME$) on conflict (human_id) do update set updated_at = now()`,
        expect: row<WriteOutcome>('denied', 'rls', 'rls', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'),
      },
      update: { sql: `update public.human_context set last_scope_home = 'city'`, expect: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },
      delete: { sql: `delete from public.human_context`, expect: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },
    },
    {
      table: 'push_tokens',
      select: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0),
      insert: {
        sql: `insert into public.push_tokens (human_id, token, platform) values ($ME$, 'authz-write-tok', 'web')`,
        expect: row<WriteOutcome>('denied', 'rls', 'rls', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok'),
      },
      update: { sql: `update public.push_tokens set platform = 'web'`, expect: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },
      delete: { sql: `delete from public.push_tokens`, expect: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },
    },

    // -- groups & conversations ---------------------------------------------------------------------
    { table: 'groups', select: row<Count>('denied', 0, 0, 1, 0, 0, 0, 1, 0) },
    { table: 'group_members', select: row<Count>('denied', 0, 0, 2, 0, 0, 0, 2, 0) },
    { table: 'conversations', select: row<Count>('denied', 0, 0, 2, 0, 1, 0, 1, 0) },
    {
      table: 'conversation_members',
      select: row<Count>('denied', 0, 0, 4, 0, 2, 0, 2, 0),
      insert: { sql: `insert into public.conversation_members (conversation_id, human_id) values (gen_random_uuid(), $SELF$)`, expect: allDenied<WriteOutcome>('denied') },
      update: { sql: `update public.conversation_members set mute_state = 'muted'`, expect: row<Count>('denied', 0, 0, 2, 0, 1, 0, 1, 0) },
      delete: { sql: `delete from public.conversation_members`, expect: allDenied<Count>('denied') },
    },
    { table: 'messages', select: row<Count>('denied', 0, 0, 3, 0, 1, 0, 2, 0) },
    { table: 'message_reactions', select: row<Count>('denied', 0, 0, 2, 0, 1, 0, 1, 0) },

    // -- notifications ------------------------------------------------------------------------------
    { table: 'notifications', select: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },

    // -- posts --------------------------------------------------------------------------------------
    { table: 'posts', select: row<Count>(2, 2, 2, 3, 2, 3, 1, 2, 2) },
    { table: 'post_media', select: row<Count>(1, 1, 1, 1, 1, 1, 0, 1, 1) },
    { table: 'post_reactions', select: row<Count>(2, 2, 2, 2, 2, 2, 0, 2, 2) },
    { table: 'post_hides', select: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },

    // -- rooms --------------------------------------------------------------------------------------
    { table: 'rooms', select: row<Count>(1, 0, 1, 1, 1, 1, 0, 1, 1) },
    { table: 'room_participants', select: row<Count>(1, 0, 1, 2, 1, 1, 0, 2, 1) },

    // -- location & safety --------------------------------------------------------------------------
    { table: 'location_shares', select: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },
    { table: 'reports', select: row<Count>('denied', 0, 0, 1, 0, 0, 0, 0, 0) },
  ]

  it('every base table in schema public is covered by an expectation entry', async () => {
    const { rows } = await db.sql.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    )
    const existing = rows.map((r) => r.tablename)
    const covered = new Set(cases.map((c) => c.table))
    const uncovered = existing.filter((t) => !covered.has(t))
    expect(uncovered, 'uncovered public tables').toEqual([])
    const stale = [...covered].filter((t) => !existing.includes(t))
    expect(stale, 'expectation entries for tables that do not exist').toEqual([])
    expect(covered.size, 'coverage set size equals base table count').toBe(existing.length)
  })

  it('every covered table has row level security enabled', async () => {
    for (const { table } of cases) {
      const { rows } = await db.sql.query<{ rls: boolean }>(
        'select relrowsecurity as rls from pg_class where oid = $1::regclass',
        [`public.${table}`],
      )
      expect(rows[0]?.rls, `${table} RLS`).toBe(true)
    }
  })

  for (const tableCase of cases) {
    describe(`public.${tableCase.table}`, () => {
      for (const actor of ACTORS) {
        it(`select as ${actor}`, async () => {
          const expected = tableCase.select[actor]
          const outcome = await run(actor, `select * from public.${tableCase.table}`)
          if (expected === 'denied') {
            expect(outcome.kind).toBe('denied')
          } else if (expected === 'full') {
            expect(outcome).toEqual({ kind: 'ok', rows: fullCounts[tableCase.table] })
          } else {
            expect(outcome).toEqual({ kind: 'ok', rows: expected })
          }
        })
      }

      if (tableCase.insert === undefined && tableCase.update === undefined && tableCase.delete === undefined) {
        // No client write path: prove it structurally (covers all nine callers via the two DB roles).
        it('has no client write privilege (anon and authenticated)', async () => {
          for (const role of ['anon', 'authenticated']) {
            for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
              const { rows } = await db.sql.query<{ ok: boolean }>('select has_table_privilege($1, $2, $3) as ok', [
                role,
                `public.${tableCase.table}`,
                privilege,
              ])
              expect(rows[0]?.ok, `${role} ${privilege} on ${tableCase.table}`).toBe(false)
            }
          }
        })
      } else {
        for (const actor of ACTORS) {
          if (tableCase.insert !== undefined) {
            const spec = tableCase.insert
            it(`insert as ${actor}`, async () => {
              expect((await run(actor, bind(actor, spec.sql))).kind).toBe(spec.expect[actor])
            })
          }
          if (tableCase.update !== undefined) {
            const spec = tableCase.update
            it(`update as ${actor}`, async () => {
              const expected = spec.expect[actor]
              const outcome = await run(actor, bind(actor, spec.sql))
              if (expected === 'denied') expect(outcome.kind).toBe('denied')
              else expect(outcome).toEqual({ kind: 'ok', rows: expected as number })
            })
          }
          if (tableCase.delete !== undefined) {
            const spec = tableCase.delete
            it(`delete as ${actor}`, async () => {
              const expected = spec.expect[actor]
              const outcome = await run(actor, bind(actor, spec.sql))
              if (expected === 'denied') expect(outcome.kind).toBe('denied')
              else expect(outcome).toEqual({ kind: 'ok', rows: expected as number })
            })
          }
        }
      }
    })
  }
})
