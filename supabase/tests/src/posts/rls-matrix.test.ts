/**
 * Authorization matrix for the post tables (ARCHITECTURE §15, spec §114; DB_API §4 RLS): what each
 * caller kind can select, insert, update and delete on `posts`, `post_media`, `post_reactions` and
 * `post_hides` through the API roles. Nobody writes directly; reads follow earth.can_view_post
 * (audience, blocks, area context, PUBLIC_WORLD_ENABLED) and hides are private.
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
  createMedia,
  createPost,
  setContext,
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

describe('RLS matrix: posts, post_media, post_reactions, post_hides', () => {
  let db: TestDb
  let actorSpec: Record<Actor, RoleSpec>
  let humans: Record<'self' | 'other' | 'friend' | 'blocked' | 'member', Human>
  let selfWorld: string
  let selfFriends: string
  let otherWorld: string

  beforeAll(async () => {
    db = await createTestDb()
    const self = await createHuman(db, { handle: 'self', displayName: 'Self' })
    const other = await createHuman(db, { handle: 'other', displayName: 'Other' })
    const friend = await createHuman(db, { handle: 'friend', displayName: 'Friend' })
    const blocked = await createHuman(db, { handle: 'blocked', displayName: 'Blocked' })
    const member = await createHuman(db, { handle: 'member', displayName: 'Member' })
    const claiming = await createHuman(db, { handle: 'claiming', status: 'pending' })
    const guest = await createGuest(db)
    humans = { self, other, friend, blocked, member }
    await befriend(db, self, friend)
    const group = await createGroup(db, self, 'Crew')
    await addMember(db, group, member)
    const sf = await createArea(db, { name: 'San Francisco', slug: 'sf', type: 'city' })
    await setContext(db, self, { currentCityId: sf })
    await setContext(db, member, { currentCityId: sf })

    // self: friends (with media), world (with media, reactions), neighborhood (SF), removed.
    selfFriends = (
      await createPost(db, self, {
        type: 'image',
        text: 'friends',
        audience: 'friends',
        media: [await createMedia(db, self)],
      })
    ).post.id
    selfWorld = (
      await createPost(db, self, {
        type: 'image',
        text: 'world',
        audience: 'world',
        media: [await createMedia(db, self)],
      })
    ).post.id
    await createPost(db, self, { text: 'sf', audience: 'neighborhood', areaId: sf })
    const removed = (await createPost(db, self, { text: 'gone', audience: 'world' })).post.id
    await db.rpc('post_delete', { post_id: removed }, self.as)
    // friend: friends post (self sees it as a friend); other: world; blocked: world with media.
    await createPost(db, friend, { text: 'friend friends', audience: 'friends' })
    otherWorld = (await createPost(db, other, { text: 'other world', audience: 'world' })).post.id
    const blockedWorld = (
      await createPost(db, blocked, {
        type: 'image',
        text: 'blocked world',
        audience: 'world',
        media: [await createMedia(db, blocked)],
      })
    ).post.id

    await db.rpc('post_reaction_set', { post_id: selfWorld, reaction_type: 'heart' }, self.as)
    await db.rpc('post_reaction_set', { post_id: selfWorld, reaction_type: 'heart' }, friend.as)
    await db.rpc('post_reaction_set', { post_id: selfWorld, reaction_type: 'heart' }, other.as)
    await db.rpc('post_reaction_set', { post_id: selfFriends, reaction_type: 'fire' }, friend.as)
    await db.rpc('post_reaction_set', { post_id: blockedWorld, reaction_type: 'heart' }, other.as)
    await db.rpc('post_hide', { post_id: otherWorld }, self.as)
    await db.rpc('post_hide', { post_id: otherWorld }, friend.as)
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
      table: 'posts',
      // visitor/guest/claiming: the 3 world posts. self: own 4 (removed included) + friend's friends post + other's world (blocked's is hidden).
      // other: 3 world (no context → no neighborhood). friend: self's 3 + own + other + blocked = 6. blocked: other + own = 2.
      // member: self world + self neighborhood (same city) + other + blocked = 4.
      select: {
        visitor: 3,
        guest: 3,
        claiming: 3,
        self: 6,
        other: 3,
        friend: 6,
        blocked: 2,
        member: 4,
      },
      insert: `insert into public.posts (author_human_id, type, text, audience) values ('${humans.self.humanId}', 'text', 'direct', 'world')`,
      update: `update public.posts set text = 'edited' where id = '${selfWorld}'`,
      delete: `delete from public.posts where id = '${selfWorld}'`,
    },
    {
      table: 'post_media',
      // Media on self's world post (public), self's friends post (friends), blocked's world post.
      select: {
        visitor: 2,
        guest: 2,
        claiming: 2,
        self: 2,
        other: 2,
        friend: 3,
        blocked: 1,
        member: 2,
      },
      insert: `insert into public.post_media (post_id, media_object_id, media_type, storage_key) select '${selfWorld}', id, 'image', storage_key from public.media_objects limit 1`,
      update: `update public.post_media set width = 1`,
      delete: `delete from public.post_media`,
    },
    {
      table: 'post_reactions',
      // 3 on self's world post, 1 on self's friends post, 1 on blocked's world post.
      select: {
        visitor: 4,
        guest: 4,
        claiming: 4,
        self: 4,
        other: 4,
        friend: 5,
        blocked: 1,
        member: 4,
      },
      insert: `insert into public.post_reactions (post_id, human_id, reaction_type) values ('${selfWorld}', '${humans.member.humanId}', 'heart')`,
      update: `update public.post_reactions set reaction_type = 'fire'`,
      delete: `delete from public.post_reactions`,
    },
    {
      table: 'post_hides',
      select: {
        visitor: 'denied',
        guest: 0,
        claiming: 0,
        self: 1,
        other: 0,
        friend: 1,
        blocked: 0,
        member: 0,
      },
      insert: `insert into public.post_hides (human_id, post_id) values ('${humans.member.humanId}', '${otherWorld}')`,
      update: `update public.post_hides set created_at = now()`,
      delete: `delete from public.post_hides`,
    },
  ]

  for (const table of ['posts', 'post_media', 'post_reactions', 'post_hides']) {
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

  it('the service role reads every row', async () => {
    const asService = await db.asRole('service', (c) =>
      c.query('select count(*)::int as n from public.posts'),
    )
    expect(asService.rows[0]?.n).toBe(7)
  })
})
