/**
 * Development fixtures (spec §117; DB_API §10): supabase/seed/010_fixtures.sql and
 * 020_dev_settings.sql, applied the way scripts/db/migrate.ts applies them (runSeeds: one
 * transaction per file, never recorded in the ledger) onto a fresh migrated scratch database, twice.
 * Asserts the inventory documented in supabase/seed/README.md, that fixture Humans leave every
 * visitor-facing surface when app_settings.environment = 'production' and are back otherwise, that
 * the documented invite tokens preview and join, and the authorization outcomes of the seeded data
 * for every caller kind (visitor, guest, claiming, owner, member, non-member, friend, blocked).
 */
import {
  ConversationsListDtoSchema,
  FeedCandidateSchema,
  GroupDetailDtoSchema,
  GroupInvitePreviewDtoSchema,
  GroupJoinDtoSchema,
  MessagesPageDtoSchema,
  NotificationsPageDtoSchema,
  PostDetailDtoSchema,
  ProfileDtoSchema,
  RoomDtoSchema,
  SearchResultsDtoSchema,
} from '@earth/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MigrationError, runSeeds, type Logger } from '../../../../scripts/db/migrate-core'
import { SEED_DIR, listSqlFiles, readSql } from '../../../../scripts/db/migrate-lib'
import {
  count,
  createGuest,
  createHuman,
  createUnclaimed,
  scalar,
  setSetting,
} from '../admission/fixtures'
import { createTestDb, type RoleSpec, type TestDb } from '../harness'

/** Fixed ids of supabase/seed/010_fixtures.sql (README.md "Fixture Humans"). */
const HUMAN = {
  xavier: 'b0000000-0000-4000-8000-000000000001',
  maya: 'b0000000-0000-4000-8000-000000000002',
  kavon: 'b0000000-0000-4000-8000-000000000003',
  sarah: 'b0000000-0000-4000-8000-000000000004',
  ben: 'b0000000-0000-4000-8000-000000000005',
  chris: 'b0000000-0000-4000-8000-000000000006',
  alex: 'b0000000-0000-4000-8000-000000000007',
  sam: 'b0000000-0000-4000-8000-000000000008',
} as const
const USER = {
  xavier: 'a0000000-0000-4000-8000-000000000001',
  maya: 'a0000000-0000-4000-8000-000000000002',
  kavon: 'a0000000-0000-4000-8000-000000000003',
  sarah: 'a0000000-0000-4000-8000-000000000004',
  ben: 'a0000000-0000-4000-8000-000000000005',
  chris: 'a0000000-0000-4000-8000-000000000006',
  alex: 'a0000000-0000-4000-8000-000000000007',
  sam: 'a0000000-0000-4000-8000-000000000008',
} as const
const GUEST_USER_ID = 'a0000000-0000-4000-8000-0000000000a1'
type Fixture = keyof typeof HUMAN
const FIXTURES = ['xavier', 'maya', 'kavon', 'sarah', 'ben', 'chris', 'alex', 'sam'] as const
const TOKENS = { weekendCrew: 'weekend-crew-dev-token', college: 'college-dev-token' } as const
const SEED_FILES = ['010_fixtures.sql', '020_dev_settings.sql', 'areas.sql']
const FLAG_DEFAULTS =
  'CITY_ENABLED:true,FRIENDS_LIVE_EXPANSION_ENABLED:true,GROUP_ANCHORED_CLAIM_REQUIRED:true,' +
  'GUEST_ROOMS_ENABLED:true,LOCATION_SHARING_ENABLED:true,MAFIA_ACTIVITY_ENABLED:false,' +
  'NEIGHBORHOOD_ENABLED:true,PUBLIC_LIVE_ENABLED:true,PUBLIC_WORLD_ENABLED:true,WORLD_ENABLED:true,' +
  'WORLD_LIVE_EXPANSION_ENABLED:true'

const as = (name: Fixture): RoleSpec => ({ userId: USER[name] })
const silent: Logger = { info: () => undefined }
const fixtureIds = Object.values(HUMAN)
const sorted = (values: readonly string[]): string[] => [...values].sort()

const FeedResultSchema = z.object({
  candidates: z.array(FeedCandidateSchema),
  scope: z.string(),
})

async function applySeeds(db: TestDb): Promise<string[]> {
  return runSeeds(db.sql, await listSqlFiles(SEED_DIR), readSql, silent)
}

/** Every fixture-related count plus the feature flag digest: identical after every application. */
async function snapshot(db: TestDb): Promise<Record<string, number | string | string[]>> {
  const tables: Array<[string, string, string?]> = [
    ['humans', 'public.humans', 'is_fixture'],
    ['humans_any', 'public.humans'],
    ['auth_users', 'auth.users'],
    ['identities', 'public.public_identities'],
    ['auth_identities', 'public.auth_identities'],
    ['passes', 'public.human_passes'],
    ['pass_metadata', 'private.human_pass_metadata'],
    ['context', 'public.human_context'],
    ['presence', 'public.human_presence'],
    ['relationships', 'public.relationships'],
    ['blocks', 'public.blocks'],
    ['groups', 'public.groups'],
    ['group_members', 'public.group_members'],
    ['group_invites', 'public.group_invites'],
    ['conversations', 'public.conversations'],
    ['conversation_members', 'public.conversation_members'],
    ['messages', 'public.messages'],
    ['message_reactions', 'public.message_reactions'],
    ['posts', 'public.posts'],
    ['post_reactions', 'public.post_reactions'],
    ['rooms', 'public.rooms'],
    ['room_participants', 'public.room_participants'],
    ['room_invites', 'public.room_invites'],
    ['guest_sessions', 'public.guest_sessions'],
    ['notifications', 'public.notifications'],
    ['cooldowns', 'public.notification_cooldowns'],
    ['places', 'public.places'],
    ['fixture_places', 'public.places', 'is_fixture'],
    ['areas', 'public.areas'],
    ['settings', 'public.app_settings'],
    ['flags', 'public.feature_flags'],
    ['ledger', 'public.earth_migrations'],
  ]
  const result: Record<string, number | string | string[]> = {}
  for (const [label, table, where] of tables) {
    result[label] = await count(db, table, where ?? 'true')
  }
  result['flag_digest'] = await scalar<string>(
    db,
    `select string_agg(key || ':' || enabled::text, ',' order by key) from public.feature_flags`,
  )
  result['fixture_human_ids'] = (
    await db.sql.query<{ id: string }>('select id from public.humans where is_fixture order by id')
  ).rows.map((row) => row.id)
  result['fixture_user_ids'] = (
    await db.sql.query<{ id: string }>(
      `select id from auth.users where id = any($1) or id = $2 order by id`,
      [Object.values(USER), GUEST_USER_ID],
    )
  ).rows.map((row) => row.id)
  return result
}

interface GroupRef {
  groupId: string
  conversationId: string
}

async function groupByName(db: TestDb, name: string): Promise<GroupRef> {
  const { rows } = await db.sql.query<{ id: string; conversation_id: string }>(
    `select g.id, c.id as conversation_id
       from public.groups g join public.conversations c on c.group_id = g.id
      where g.name = $1`,
    [name],
  )
  const row = rows[0]
  if (row === undefined) throw new Error(`group ${name} missing`)
  return { groupId: row.id, conversationId: row.conversation_id }
}

async function postByText(db: TestDb, prefix: string): Promise<string> {
  const id = await scalar<string | null>(
    db,
    `select id from public.posts where text like $1 || '%' order by created_at limit 1`,
    [prefix],
  )
  if (id === null) throw new Error(`post "${prefix}" missing`)
  return id
}

async function roomByContext(db: TestDb, contextType: 'group' | 'standalone'): Promise<string> {
  const id = await scalar<string | null>(
    db,
    'select id from public.rooms where context_type = $1::public.room_context_type',
    [contextType],
  )
  if (id === null) throw new Error(`${contextType} room missing`)
  return id
}

/** Seconds between now and a timestamp column of one row. */
async function ageSeconds(db: TestDb, query: string, values: unknown[] = []): Promise<number> {
  return Number(await scalar<string>(db, `select extract(epoch from now() - (${query}))`, values))
}

async function feedWorld(db: TestDb, caller: RoleSpec): Promise<string[]> {
  const result = FeedResultSchema.parse(
    await db.rpc(
      'feed_candidates',
      { scope: 'world', area_id: null, snapshot_at: null, limit: null },
      caller,
    ),
  )
  return sorted(result.candidates.map((candidate) => candidate.authorHumanId ?? ''))
}

async function search(db: TestDb, q: string, caller: RoleSpec) {
  return SearchResultsDtoSchema.parse(await db.rpc('search', { q, limit: 10 }, caller))
}

async function preview(db: TestDb, token: string, caller: RoleSpec) {
  return GroupInvitePreviewDtoSchema.parse(await db.rpc('group_invite_preview', { token }, caller))
}

async function messages(db: TestDb, conversationId: string, caller: RoleSpec) {
  return MessagesPageDtoSchema.parse(
    await db.rpc(
      'messages_list',
      { conversation_id: conversationId, before_id: null, limit: 200 },
      caller,
    ),
  )
}

describe('development seed fixtures (spec §117; DB_API §10)', () => {
  let db: TestDb
  let applied: string[]
  let first: Awaited<ReturnType<typeof snapshot>>
  let crew: GroupRef
  let college: GroupRef
  let dm: string
  let crewRoom: string
  let walkRoom: string
  let sunrise: string
  let mayaFriendsPost: string
  let benWorldPost: string

  /** Groups, rooms and posts get fresh ids on every application; Human ids never change. */
  async function resolveRefs(): Promise<void> {
    crew = await groupByName(db, 'Weekend Crew')
    college = await groupByName(db, 'College')
    dm = await scalar<string>(db, `select id from public.conversations where type = 'direct'`)
    crewRoom = await roomByContext(db, 'group')
    walkRoom = await roomByContext(db, 'standalone')
    sunrise = await postByText(db, 'First fog-free sunrise')
    mayaFriendsPost = await postByText(db, 'Not to be dramatic')
    benWorldPost = await postByText(db, 'Hosting dinner next weekend')
  }

  beforeAll(async () => {
    db = await createTestDb()
    applied = await applySeeds(db)
    first = await snapshot(db)
    await resolveRefs()
  })

  afterAll(async () => {
    await db.drop()
  })

  describe('applying the seeds', () => {
    it('applies 010_fixtures, 020_dev_settings and areas in lexical order onto a fresh migrated database, recording nothing in the ledger', async () => {
      expect(applied).toEqual(SEED_FILES)
      expect(await count(db, 'public.earth_migrations', 'name = any($1)', [SEED_FILES])).toBe(0)
      expect(first['humans']).toBe(8)
      expect(first['fixture_human_ids']).toEqual(sorted(fixtureIds))
      expect(first['fixture_user_ids']).toEqual(sorted([...Object.values(USER), GUEST_USER_ID]))
      expect(await scalar(db, `value from public.app_settings where key = 'environment'`)).toBe(
        'development',
      )
    })

    it('is idempotent: a second application leaves the same inventory and the same fixed ids', async () => {
      const before = { ...crew }
      expect(await applySeeds(db)).toEqual(SEED_FILES)
      expect(await snapshot(db)).toEqual(first)
      await resolveRefs()
      // Recreated, not reused: fixture-owned rows are rebuilt from scratch on every application.
      expect(crew.groupId).not.toBe(before.groupId)
      // Memberships still come from the tokens: use counts are reset with the invites.
      expect(
        await count(
          db,
          'public.group_invites',
          "status = 'active' and use_count = 3 and expires_at is null",
        ),
      ).toBe(2)
    })

    it('refuses to run when app_settings.environment = production and leaves the database untouched', async () => {
      await setSetting(db, 'environment', 'production')
      try {
        const failure = await applySeeds(db).then(
          () => null,
          (error: unknown) => error,
        )
        expect(failure).toBeInstanceOf(MigrationError)
        expect((failure as MigrationError).file).toBe('010_fixtures.sql')
        expect((failure as MigrationError).message).toMatch(/production/)
        // 020_dev_settings.sql refuses on its own as well: it never flips a production database back.
        const files = (await listSqlFiles(SEED_DIR)).filter(
          (file) => file.name === '020_dev_settings.sql',
        )
        const settingsFailure = await runSeeds(db.sql, files, readSql, silent).then(
          () => null,
          (error: unknown) => error,
        )
        expect(settingsFailure).toBeInstanceOf(MigrationError)
        expect((settingsFailure as MigrationError).file).toBe('020_dev_settings.sql')
        expect(await scalar(db, `value from public.app_settings where key = 'environment'`)).toBe(
          'production',
        )
      } finally {
        await setSetting(db, 'environment', 'development')
      }
      expect(await snapshot(db)).toEqual(first)
      await resolveRefs()
    })
  })

  describe('inventory (supabase/seed/README.md)', () => {
    it('Humans: eight active fixtures verified by the mock provider, public handles, San Francisco context in North Beach or the Mission', async () => {
      const { rows } = await db.sql.query<{
        id: string
        handle: string
        display_name: string
        status: string
        pass: string
        is_fixture: boolean
        claimed: boolean
        visibility: string
        provider: string
        pass_status: string
        risk_level: string | null
        verified: boolean
        neighborhood: string | null
        city: string | null
        home: string | null
        home_city: string | null
      }>(
        `select h.id, p.handle, p.display_name, h.status::text, h.human_pass_status::text as pass, h.is_fixture,
                h.claimed_at is not null as claimed, p.profile_visibility::text as visibility,
                hp.provider, hp.status::text as pass_status, hp.risk_level, hp.verified_at is not null as verified,
                n.slug as neighborhood, c.slug as city, hm.slug as home, pc.slug as home_city
           from public.humans h
           join public.public_identities p on p.human_id = h.id
           join public.human_passes hp on hp.human_id = h.id
           left join public.human_context hc on hc.human_id = h.id
           left join public.areas n on n.id = hc.current_area_id
           left join public.areas c on c.id = hc.current_city_id
           left join public.areas hm on hm.id = hc.home_city_id
           left join public.areas pc on pc.id = p.home_city_area_id
          where h.is_fixture
          order by p.handle`,
      )
      const sf = 'usa-ca-san-francisco'
      const nb = 'usa-ca-san-francisco-north-beach'
      const mission = 'usa-ca-san-francisco-mission'
      expect(rows.map((row) => row.handle)).toEqual(sorted(FIXTURES))
      for (const row of rows) {
        expect(row).toMatchObject({
          id: HUMAN[row.handle as Fixture],
          display_name: row.handle.charAt(0).toUpperCase() + row.handle.slice(1),
          status: 'active',
          pass: 'verified',
          is_fixture: true,
          claimed: true,
          visibility: 'public',
          provider: 'mock',
          pass_status: 'verified',
          risk_level: 'low',
          verified: true,
          city: sf,
          home: sf,
          home_city: sf,
        })
        expect([nb, mission]).toContain(row.neighborhood)
      }
      expect(rows.filter((row) => row.neighborhood === nb).map((row) => row.handle)).toEqual([
        'alex',
        'chris',
        'kavon',
        'xavier',
      ])
      expect(await count(db, 'private.human_pass_metadata')).toBe(8)
      expect(
        await count(db, 'public.auth_identities', "provider = 'supabase' and human_id = any($1)", [
          fixtureIds,
        ]),
      ).toBe(8)
      expect(
        await count(db, 'public.auth_identities', "provider = 'email' and human_id = any($1)", [
          fixtureIds,
        ]),
      ).toBe(8)
      expect(await count(db, 'public.human_presence', 'human_id = any($1)', [fixtureIds])).toBe(8)
      expect(await count(db, 'public.media_objects')).toBe(0)
    })

    it('credentials: confirmed auth users with the documented emails and fixed ids, plus one anonymous Guest credential', async () => {
      const { rows } = await db.sql.query<{
        id: string
        email: string | null
        aud: string
        role: string
        confirmed: boolean
        is_anonymous: boolean
        instance_id: string
        linked: string | null
      }>(
        `select u.id, u.email, u.aud, u.role, u.email_confirmed_at is not null as confirmed, u.is_anonymous,
                u.instance_id, h.id as linked
           from auth.users u left join public.humans h on h.auth_user_id = u.id
          where u.id = any($1) or u.id = $2
          order by u.email nulls last`,
        [Object.values(USER), GUEST_USER_ID],
      )
      expect(rows).toHaveLength(9)
      for (const name of FIXTURES) {
        expect(rows).toContainEqual({
          id: USER[name],
          email: `${name}@fixtures.earth.local`,
          aud: 'authenticated',
          role: 'authenticated',
          confirmed: true,
          is_anonymous: false,
          instance_id: '00000000-0000-0000-0000-000000000000',
          linked: HUMAN[name],
        })
      }
      expect(rows.find((row) => row.id === GUEST_USER_ID)).toMatchObject({
        email: null,
        is_anonymous: true,
        linked: null,
      })
    })

    it('social graph: six friendships both ways, two follows, one pending request with its notifications', async () => {
      const { rows } = await db.sql.query<{ type: string; n: string }>(
        `select type::text, count(*)::text as n from public.relationships group by 1 order by 1`,
      )
      expect(rows).toEqual([
        { type: 'follow', n: '2' },
        { type: 'friend', n: '12' },
        { type: 'friend_pending', n: '1' },
      ])
      const pairs: Array<[Fixture, Fixture]> = [
        ['xavier', 'maya'],
        ['xavier', 'kavon'],
        ['kavon', 'maya'],
        ['maya', 'sarah'],
        ['ben', 'chris'],
        ['sarah', 'ben'],
      ]
      for (const [a, b] of pairs) {
        expect(
          await scalar<boolean>(db, 'select earth.are_friends($1, $2)', [HUMAN[a], HUMAN[b]]),
        ).toBe(true)
      }
      expect(
        await scalar<boolean>(db, 'select earth.are_friends($1, $2)', [HUMAN.ben, HUMAN.xavier]),
      ).toBe(false)
      expect(
        await scalar<boolean>(db, 'select earth.is_following($1, $2)', [HUMAN.alex, HUMAN.xavier]),
      ).toBe(true)
      expect(
        await scalar<boolean>(db, 'select earth.is_following($1, $2)', [HUMAN.sam, HUMAN.maya]),
      ).toBe(true)
      expect(await count(db, 'public.blocks')).toBe(0)

      const kavon = NotificationsPageDtoSchema.parse(
        await db.rpc('notifications_list', { cursor: null, limit: 30 }, as('kavon')),
      )
      const pending = kavon.notifications.find(
        (n) => n.type === 'friend_request' && n.readAt === null,
      )
      expect(pending).toMatchObject({
        actorHumanId: HUMAN.alex,
        objectType: 'human',
        objectId: HUMAN.alex,
      })
      expect(kavon.unreadCount).toBeGreaterThanOrEqual(1)
      const xavier = NotificationsPageDtoSchema.parse(
        await db.rpc('notifications_list', { cursor: null, limit: 30 }, as('xavier')),
      )
      expect(xavier.notifications.filter((n) => n.type === 'follow')).toMatchObject([
        { actorHumanId: HUMAN.alex, readAt: null },
      ])
      // Nothing carries the transaction timestamp: every notification is backdated into the story.
      expect(
        await count(db, 'public.notifications', "created_at > now() - interval '2 minutes'"),
      ).toBe(0)
      expect(
        await count(db, 'public.notifications', "created_at < now() - interval '30 days'"),
      ).toBe(0)
    })

    it('groups: Weekend Crew (Xavier owner; Maya, Kavon, Sarah) and College (Maya owner; Ben, Chris, Sam), one active token invite each used three times', async () => {
      const crewDetail = GroupDetailDtoSchema.parse(
        await db.rpc('group_get', { group_id: crew.groupId }, as('xavier')),
      )
      expect(crewDetail).toMatchObject({
        name: 'Weekend Crew',
        kind: 'persistent',
        status: 'active',
        createdByHumanId: HUMAN.xavier,
        conversationId: crew.conversationId,
        memberCount: 4,
        myRole: 'owner',
        activeRoom: null,
      })
      expect(sorted(crewDetail.members.map((m) => m.handle))).toEqual([
        'kavon',
        'maya',
        'sarah',
        'xavier',
      ])
      expect(crewDetail.members.find((m) => m.handle === 'xavier')?.role).toBe('owner')
      expect(
        crewDetail.members
          .filter((m) => m.role === 'member')
          .map((m) => m.handle)
          .sort(),
      ).toEqual(['kavon', 'maya', 'sarah'])
      const collegeDetail = GroupDetailDtoSchema.parse(
        await db.rpc('group_get', { group_id: college.groupId }, as('maya')),
      )
      expect(collegeDetail).toMatchObject({ name: 'College', memberCount: 4, myRole: 'owner' })
      expect(sorted(collegeDetail.members.map((m) => m.handle))).toEqual([
        'ben',
        'chris',
        'maya',
        'sam',
      ])
      expect(
        await ageSeconds(db, 'select created_at from public.groups where id = $1', [crew.groupId]),
      ).toBeGreaterThan(30 * 86400)

      const { rows } = await db.sql.query<{
        group_id: string
        created_by: string
        status: string
        use_count: number
        max_uses: number | null
        expires_at: string | null
        matches: boolean
      }>(
        `select gi.group_id, gi.created_by, gi.status, gi.use_count, gi.max_uses, gi.expires_at,
                gi.token_hash = earth.sha256_hex(case when gi.group_id = $1 then $3 else $4 end) as matches
           from public.group_invites gi
          where gi.group_id in ($1, $2)
          order by gi.group_id = $1 desc`,
        [crew.groupId, college.groupId, TOKENS.weekendCrew, TOKENS.college],
      )
      expect(rows).toEqual([
        {
          group_id: crew.groupId,
          created_by: HUMAN.xavier,
          status: 'active',
          use_count: 3,
          max_uses: null,
          expires_at: null,
          matches: true,
        },
        {
          group_id: college.groupId,
          created_by: HUMAN.maya,
          status: 'active',
          use_count: 3,
          max_uses: null,
          expires_at: null,
          matches: true,
        },
      ])
      expect(await count(db, 'public.groups')).toBe(2)
    })

    it('conversations: 36 / 34 messages over the last three days with the join and Live system lines, a 9-message DM, real unread badges and reactions', async () => {
      const crewPage = await messages(db, crew.conversationId, as('xavier'))
      expect(crewPage.messages).toHaveLength(36)
      expect(crewPage.nextCursor).toBeNull()
      const system = crewPage.messages.filter((m) => m.type === 'system')
      expect(sorted(system.map((m) => m.text ?? ''))).toEqual([
        'Kavon joined',
        'Maya joined',
        'Sarah joined',
        'Xavier started a video',
      ])
      for (const line of system) {
        expect(line.clientId).toBeNull()
        expect(line.payload['actorHumanId']).toBe(line.senderHumanId)
      }
      const chat = crewPage.messages.filter((m) => m.type === 'text')
      expect(chat).toHaveLength(32)
      for (const message of chat) {
        expect(message.clientId).not.toBeNull()
        expect(message.text?.length ?? 0).toBeGreaterThan(0)
        expect(Date.now() - Date.parse(message.createdAt)).toBeLessThan(73 * 3600 * 1000)
      }
      expect(sorted([...new Set(chat.map((m) => m.senderHumanId))])).toEqual(
        sorted([HUMAN.xavier, HUMAN.maya, HUMAN.kavon, HUMAN.sarah]),
      )
      const newest = crewPage.messages[0]
      expect(newest?.text).toBe('Undefeated and tired. Nap time')
      expect(Date.now() - Date.parse(newest?.createdAt ?? '')).toBeLessThan(10 * 60 * 1000)
      expect(crewPage.messages.filter((m) => m.reactions.length > 0)).toHaveLength(2)

      const collegePage = await messages(db, college.conversationId, as('maya'))
      expect(collegePage.messages).toHaveLength(34)
      expect(collegePage.messages.filter((m) => m.type === 'system')).toHaveLength(3)
      expect(collegePage.messages.filter((m) => m.type === 'text')).toHaveLength(31)
      const dmPage = await messages(db, dm, as('maya'))
      expect(dmPage.messages).toHaveLength(9)
      expect(await count(db, 'public.message_reactions')).toBe(5)
      expect(await count(db, 'public.messages')).toBe(79)

      const xavierChats = ConversationsListDtoSchema.parse(
        await db.rpc('conversations_list', { cursor: null, limit: 30 }, as('xavier')),
      )
      expect(xavierChats.conversations.map((c) => [c.title, c.unreadCount])).toEqual([
        ['Weekend Crew', 0],
        ['Maya', 1],
      ])
      expect(xavierChats.conversations[0]?.lastMessage?.text).toBe('Undefeated and tired. Nap time')
      const sarahChats = ConversationsListDtoSchema.parse(
        await db.rpc('conversations_list', { cursor: null, limit: 30 }, as('sarah')),
      )
      expect(sarahChats.conversations.map((c) => [c.title, c.unreadCount])).toEqual([
        ['Weekend Crew', 3],
      ])
      const chrisChats = ConversationsListDtoSchema.parse(
        await db.rpc('conversations_list', { cursor: null, limit: 30 }, as('chris')),
      )
      expect(chrisChats.conversations.map((c) => [c.title, c.unreadCount])).toEqual([
        ['College', 4],
      ])
      const mayaChats = ConversationsListDtoSchema.parse(
        await db.rpc('conversations_list', { cursor: null, limit: 30 }, as('maya')),
      )
      expect(sorted(mayaChats.conversations.map((c) => c.title))).toEqual([
        'College',
        'Weekend Crew',
        'Xavier',
      ])
      expect(mayaChats.conversations.every((c) => c.unreadCount === 0)).toBe(true)
    })

    it('posts: a World post by every fixture, San Francisco city posts, North Beach / Mission neighborhood posts, friends posts and one reply thread', async () => {
      const { rows } = await db.sql.query<{ audience: string; roots: string; replies: string }>(
        `select audience::text, count(*) filter (where parent_post_id is null)::text as roots,
                count(*) filter (where parent_post_id is not null)::text as replies
           from public.posts where status = 'active' group by 1 order by 1`,
      )
      expect(rows).toEqual([
        { audience: 'city', roots: '3', replies: '0' },
        { audience: 'friends', roots: '3', replies: '0' },
        { audience: 'neighborhood', roots: '4', replies: '0' },
        { audience: 'world', roots: '8', replies: '3' },
      ])
      const worldAuthors = await db.sql.query<{ author_human_id: string }>(
        `select author_human_id from public.posts where audience = 'world' and parent_post_id is null`,
      )
      expect(sorted(worldAuthors.rows.map((row) => row.author_human_id))).toEqual(
        sorted(fixtureIds),
      )
      const areas = await db.sql.query<{ audience: string; area: string; n: string }>(
        `select p.audience::text, a.slug as area, count(*)::text as n
           from public.posts p join public.areas a on a.id = p.area_id
          where p.audience in ('city', 'neighborhood') group by 1, 2 order by 1, 2`,
      )
      expect(areas.rows).toEqual([
        { audience: 'city', area: 'usa-ca-san-francisco', n: '3' },
        { audience: 'neighborhood', area: 'usa-ca-san-francisco-mission', n: '2' },
        { audience: 'neighborhood', area: 'usa-ca-san-francisco-north-beach', n: '2' },
      ])
      expect(
        await count(
          db,
          'public.posts',
          "type = 'moment' and place_id = (select id from public.places where provider_reference = 'earth:dolores-park')",
        ),
      ).toBe(1)
      expect(await count(db, 'public.posts', 'root_post_id = $1', [sunrise])).toBe(3)
      expect(await count(db, 'public.post_reactions')).toBe(16)

      const thread = PostDetailDtoSchema.parse(
        await db.rpc('post_get', { post_id: sunrise }, 'visitor'),
      )
      expect(thread.post).toMatchObject({
        authorHumanId: HUMAN.xavier,
        audience: 'world',
        parentPostId: null,
      })
      expect(thread.author.handle).toBe('xavier')
      expect(thread.reactionCount).toBe(4)
      expect(thread.replyCount).toBe(2)
      expect(sorted(thread.replies.map((reply) => reply.author.handle))).toEqual(['kavon', 'maya'])
      const nested = thread.replies.find((reply) => reply.author.handle === 'maya')
      expect(nested?.replyCount).toBe(1)
      expect(Date.now() - Date.parse(thread.post.createdAt)).toBeLessThan(71 * 3600 * 1000)
      expect(Date.now() - Date.parse(thread.post.createdAt)).toBeGreaterThan(69 * 3600 * 1000)
    })

    it('Lives: the Weekend Crew room ended two hours ago at friends visibility with Xavier and Maya on camera and Kavon on audio; the standalone room ended with a Guest session', async () => {
      const rooms = await db.sql.query<{
        id: string
        context_type: string
        context_id: string | null
        initiator: string
        title: string | null
        visibility: string
        join_policy: string
        status: string
        pending: string | null
        active_human_count: number
        active_participant_count: number
        started_age: number
        ended_age: number
      }>(
        `select r.id, r.context_type::text, r.context_id, r.initiated_by_human_id as initiator, r.title,
                r.visibility::text, r.join_policy::text, r.status::text, r.pending_visibility::text as pending,
                r.active_human_count, r.active_participant_count,
                extract(epoch from now() - r.started_at)::float8 as started_age,
                extract(epoch from now() - r.ended_at)::float8 as ended_age
           from public.rooms r order by r.started_at`,
      )
      expect(rooms.rows).toHaveLength(2)
      const [walk, crewLive] = rooms.rows
      expect(crewLive).toMatchObject({
        id: crewRoom,
        context_type: 'group',
        context_id: crew.groupId,
        initiator: HUMAN.xavier,
        title: 'Saturday plans',
        visibility: 'friends',
        join_policy: 'friends',
        status: 'ended',
        pending: null,
        active_human_count: 0,
        active_participant_count: 0,
      })
      expect(crewLive?.started_age).toBeGreaterThan(3 * 3600 - 300)
      expect(crewLive?.started_age).toBeLessThan(3 * 3600 + 300)
      expect(crewLive?.ended_age).toBeGreaterThan(2 * 3600 - 300)
      expect(crewLive?.ended_age).toBeLessThan(2 * 3600 + 300)
      expect(walk).toMatchObject({
        id: walkRoom,
        context_type: 'standalone',
        context_id: null,
        initiator: HUMAN.sarah,
        visibility: 'friends',
        join_policy: 'friends',
        status: 'ended',
        active_participant_count: 0,
      })
      expect(walk?.ended_age).toBeGreaterThan(25 * 3600 - 300)
      expect(walk?.ended_age).toBeLessThan(25 * 3600 + 300)

      const participants = await db.sql.query<{
        room_id: string
        human_id: string | null
        guest_name: string | null
        role: string
        media_state: string
        status: string
        consent: string
        left: boolean
      }>(
        `select rp.room_id, rp.human_id, gs.display_name as guest_name, rp.role::text, rp.media_state::text,
                rp.status::text, rp.audience_consent_level::text as consent, rp.left_at is not null as left
           from public.room_participants rp left join public.guest_sessions gs on gs.id = rp.guest_session_id
          order by rp.room_id = $1 desc, rp.joined_at`,
        [crewRoom],
      )
      expect(participants.rows).toEqual([
        {
          room_id: crewRoom,
          human_id: HUMAN.xavier,
          guest_name: null,
          role: 'initiator',
          media_state: 'camera',
          status: 'left',
          consent: 'friends',
          left: true,
        },
        {
          room_id: crewRoom,
          human_id: HUMAN.maya,
          guest_name: null,
          role: 'participant',
          media_state: 'camera',
          status: 'left',
          consent: 'friends',
          left: true,
        },
        {
          room_id: crewRoom,
          human_id: HUMAN.kavon,
          guest_name: null,
          role: 'participant',
          media_state: 'audio',
          status: 'left',
          consent: 'friends',
          left: true,
        },
        {
          room_id: walkRoom,
          human_id: HUMAN.sarah,
          guest_name: null,
          role: 'initiator',
          media_state: 'camera',
          status: 'left',
          consent: 'friends',
          left: true,
        },
        {
          room_id: walkRoom,
          human_id: HUMAN.ben,
          guest_name: null,
          role: 'participant',
          media_state: 'audio',
          status: 'left',
          consent: 'friends',
          left: true,
        },
        {
          room_id: walkRoom,
          human_id: null,
          guest_name: 'Jules',
          role: 'participant',
          media_state: 'audio',
          status: 'left',
          consent: 'friends',
          left: true,
        },
      ])
      const guest = await db.sql.query<{
        auth_user_id: string
        expired: boolean
        has_invite: boolean
        removed: boolean
      }>(
        `select gs.auth_user_id, gs.expires_at < now() as expired, gs.room_invite_id is not null as has_invite,
                gs.removed_at is not null as removed
           from public.guest_sessions gs where gs.room_id = $1`,
        [walkRoom],
      )
      expect(guest.rows).toEqual([
        { auth_user_id: GUEST_USER_ID, expired: true, has_invite: true, removed: false },
      ])
      expect(
        await count(
          db,
          'public.room_invites',
          'room_id = $1 and use_count = 1 and expires_at < now()',
          [walkRoom],
        ),
      ).toBe(1)
      expect(
        await scalar(db, 'active_room_id from public.groups where id = $1', [crew.groupId]),
      ).toBeNull()
      expect(
        await scalar(db, 'active_room_id from public.conversations where id = $1', [
          crew.conversationId,
        ]),
      ).toBeNull()
      expect(
        await count(
          db,
          'public.notifications',
          "type in ('group_live', 'friend_live', 'multi_live')",
        ),
      ).toBeGreaterThan(0)
    })

    it('places: four fixture places in North Beach / the Mission; the base rows, the other settings and every feature flag are untouched', async () => {
      const { rows } = await db.sql.query<{ name: string; area: string; category: string | null }>(
        `select p.name, a.slug as area, p.category
           from public.places p join public.areas a on a.id = p.area_id
          where p.is_fixture and a.parent_area_id = (select id from public.areas where slug = 'usa-ca-san-francisco')
          order by p.name`,
      )
      expect(rows).toEqual([
        { name: 'Caffe Trieste', area: 'usa-ca-san-francisco-north-beach', category: 'cafe' },
        { name: 'Clarion Alley', area: 'usa-ca-san-francisco-mission', category: 'landmark' },
        { name: 'Coit Tower', area: 'usa-ca-san-francisco-north-beach', category: 'landmark' },
        { name: 'Mission Dolores', area: 'usa-ca-san-francisco-mission', category: 'landmark' },
      ])
      expect(
        await count(
          db,
          'public.places',
          "not is_fixture and provider_reference = 'earth:dolores-park'",
        ),
      ).toBe(1)
      expect(
        await count(db, 'public.areas', "not is_fixture and slug = 'usa-ca-san-francisco-mission'"),
      ).toBe(1)
      expect(first['flag_digest']).toBe(FLAG_DEFAULTS)
      expect(first['flags']).toBe(11)
      const settings = await db.sql.query<{ key: string; value: string }>(
        'select key, value from public.app_settings order by key',
      )
      expect(settings.rows).toEqual([
        { key: 'environment', value: 'development' },
        { key: 'public_storage_base_url', value: '' },
        { key: 'room_grace_seconds', value: '120' },
        { key: 'web_origin', value: 'https://earth.social' },
      ])
    })
  })

  describe('fixtures and app_settings.environment (DB_API §10)', () => {
    afterEach(async () => {
      await setSetting(db, 'environment', 'development')
    })

    it('development: visitors and Guests see fixture posts in feed_candidates(world) and public_feed, fixture people and places in search, fixture profiles', async () => {
      expect(await feedWorld(db, 'visitor')).toEqual(sorted(fixtureIds))
      const guest = await createGuest(db)
      expect(await feedWorld(db, guest.as)).toEqual(sorted(fixtureIds))
      const publicFeed = FeedResultSchema.parse(
        await db.rpc('public_feed', { cursor: null, limit: 20 }, 'visitor'),
      )
      expect(publicFeed.candidates).toHaveLength(8)
      const people = await search(db, 'xavier', 'visitor')
      expect(people.people.map((p) => p.handle)).toEqual(['xavier'])
      const places = await search(db, 'trieste', 'visitor')
      expect(places.places.map((p) => p.name)).toEqual(['Caffe Trieste'])
      const profile = ProfileDtoSchema.parse(
        await db.rpc('profile_get', { handle: 'xavier' }, 'visitor'),
      )
      expect(profile.identity).toMatchObject({
        humanId: HUMAN.xavier,
        handle: 'xavier',
        cityName: 'San Francisco',
      })
      const posts = await search(db, 'jukebox', as('maya'))
      expect(posts.posts.map((p) => p.author.handle)).toEqual(['chris'])
    })

    it('production: feed_candidates(world) and public_feed drop every fixture post, search hides fixture people, places and posts, fixture profiles are not visible to visitors', async () => {
      await setSetting(db, 'environment', 'production')
      expect(await feedWorld(db, 'visitor')).toEqual([])
      expect(await feedWorld(db, (await createGuest(db)).as)).toEqual([])
      expect(await feedWorld(db, as('maya'))).toEqual([])
      const publicFeed = FeedResultSchema.parse(
        await db.rpc('public_feed', { cursor: null, limit: 20 }, 'visitor'),
      )
      expect(publicFeed.candidates).toEqual([])
      const visitorSearch = await search(db, 'xavier', 'visitor')
      expect(visitorSearch.people).toEqual([])
      expect((await search(db, 'trieste', 'visitor')).places).toEqual([])
      await db.expectError(db.rpc('profile_get', { handle: 'xavier' }, 'visitor'), 'not_visible')
      // A signed-in Human still sees the people they know; discovery of fixture content is what stops.
      const mayaSearch = await search(db, 'xavier', as('maya'))
      expect(mayaSearch.people.map((p) => p.handle)).toEqual(['xavier'])
      expect((await search(db, 'jukebox', as('maya'))).posts).toEqual([])
      expect(await count(db, 'public.posts')).toBe(21)
    })

    it('back in development the same fixtures are shown again', async () => {
      expect(await feedWorld(db, 'visitor')).toEqual(sorted(fixtureIds))
      expect((await search(db, 'xavier', 'visitor')).people.map((p) => p.handle)).toEqual([
        'xavier',
      ])
    })
  })

  describe('known invite tokens (group_invite_preview)', () => {
    it('weekend-crew-dev-token previews Weekend Crew for a visitor: four public members, not a member, not expired', async () => {
      expect(await preview(db, TOKENS.weekendCrew, 'visitor')).toEqual({
        groupName: 'Weekend Crew',
        memberCount: 4,
        sampleMembers: [
          { displayName: 'Xavier', avatarUrl: null },
          { displayName: 'Maya', avatarUrl: null },
          { displayName: 'Kavon', avatarUrl: null },
          { displayName: 'Sarah', avatarUrl: null },
        ],
        alreadyMember: false,
        expired: false,
      })
    })

    it('college-dev-token previews College; members see alreadyMember, non-members do not', async () => {
      expect(await preview(db, TOKENS.college, 'visitor')).toEqual({
        groupName: 'College',
        memberCount: 4,
        sampleMembers: [
          { displayName: 'Maya', avatarUrl: null },
          { displayName: 'Ben', avatarUrl: null },
          { displayName: 'Chris', avatarUrl: null },
          { displayName: 'Sam', avatarUrl: null },
        ],
        alreadyMember: false,
        expired: false,
      })
      const mayaCrew = await preview(db, TOKENS.weekendCrew, as('maya'))
      expect(mayaCrew.alreadyMember).toBe(true)
      expect(mayaCrew.sampleMembers.map((m) => m.displayName)).toEqual(['Xavier', 'Kavon', 'Sarah'])
      expect((await preview(db, TOKENS.college, as('maya'))).alreadyMember).toBe(true)
      expect((await preview(db, TOKENS.weekendCrew, as('ben'))).alreadyMember).toBe(false)
      expect((await preview(db, TOKENS.college, as('ben'))).alreadyMember).toBe(true)
    })

    it('Guests and claiming credentials can preview but not join; visitors cannot join; an unknown token is invite_invalid; only the hash is stored', async () => {
      const guest = await createGuest(db)
      const unclaimed = await createUnclaimed(db)
      expect((await preview(db, TOKENS.weekendCrew, guest.as)).memberCount).toBe(4)
      expect((await preview(db, TOKENS.college, unclaimed.as)).alreadyMember).toBe(false)
      await db.expectError(
        db.rpc('group_invite_join', { token: TOKENS.weekendCrew }, guest.as),
        'not_a_human',
      )
      await db.expectError(
        db.rpc('group_invite_join', { token: TOKENS.college }, unclaimed.as),
        'not_a_human',
      )
      await db.expectError(
        db.rpc('group_invite_join', { token: TOKENS.college }, 'visitor'),
        'not_authenticated',
      )
      await db.expectError(
        db.rpc('group_invite_preview', { token: 'weekend-crew-prod-token' }, 'visitor'),
        'invite_invalid',
      )
      expect(
        await count(db, 'public.group_invites', 'token_hash in ($1, $2)', [
          TOKENS.weekendCrew,
          TOKENS.college,
        ]),
      ).toBe(0)
      expect(await count(db, 'public.group_invites', 'length(token_hash) = 64')).toBe(2)
    })
  })

  describe('authorization on the seeded data', () => {
    it('visitor: World posts and the sunrise thread, nothing else', async () => {
      expect(await feedWorld(db, 'visitor')).toHaveLength(8)
      await db.expectError(
        db.rpc(
          'feed_candidates',
          { scope: 'friends', area_id: null, snapshot_at: null, limit: null },
          'visitor',
        ),
        'not_authenticated',
      )
      await db.expectError(
        db.rpc('post_get', { post_id: mayaFriendsPost }, 'visitor'),
        'post_not_found',
      )
      await db.expectError(
        db.rpc('group_get', { group_id: crew.groupId }, 'visitor'),
        'not_authenticated',
      )
      await db.expectError(
        db.rpc(
          'messages_list',
          { conversation_id: crew.conversationId, before_id: null, limit: 50 },
          'visitor',
        ),
        'not_authenticated',
      )
      await db.expectError(db.rpc('room_get', { room_id: crewRoom }, 'visitor'), 'room_not_found')
    })

    it('Guest: World only; no groups, chats or rooms of the fixtures', async () => {
      const guest = await createGuest(db)
      expect(await feedWorld(db, guest.as)).toHaveLength(8)
      await db.expectError(db.rpc('group_get', { group_id: crew.groupId }, guest.as), 'not_a_human')
      await db.expectError(
        db.rpc(
          'messages_list',
          { conversation_id: crew.conversationId, before_id: null, limit: 50 },
          guest.as,
        ),
        'not_a_human',
      )
      await db.expectError(db.rpc('room_get', { room_id: crewRoom }, guest.as), 'room_not_found')
      await db.expectError(
        db.rpc('post_get', { post_id: mayaFriendsPost }, guest.as),
        'post_not_found',
      )
    })

    it('claiming Human: no member features until the claim completes', async () => {
      const claiming = await createHuman(db, { handle: 'claimingdev', status: 'pending' })
      await db.expectError(
        db.rpc('group_get', { group_id: crew.groupId }, claiming.as),
        'not_a_human',
      )
      await db.expectError(
        db.rpc(
          'feed_candidates',
          { scope: 'friends', area_id: null, snapshot_at: null, limit: null },
          claiming.as,
        ),
        'not_authenticated',
      )
      await db.expectError(
        db.rpc('post_get', { post_id: mayaFriendsPost }, claiming.as),
        'post_not_found',
      )
      expect(await feedWorld(db, claiming.as)).toHaveLength(8)
    })

    it('owner and member: Xavier and Maya read Weekend Crew, its chat and its ended Live', async () => {
      const room = RoomDtoSchema.parse(
        await db.rpc('room_get', { room_id: crewRoom }, as('xavier')),
      )
      expect(room).toMatchObject({
        status: 'ended',
        visibility: 'friends',
        contextTitle: 'Weekend Crew',
        contextId: crew.groupId,
        participants: [],
        myParticipant: null,
      })
      expect(room.endedAt).not.toBeNull()
      const mayaView = GroupDetailDtoSchema.parse(
        await db.rpc('group_get', { group_id: crew.groupId }, as('maya')),
      )
      expect(mayaView.myRole).toBe('member')
      expect((await messages(db, crew.conversationId, as('maya'))).messages).toHaveLength(36)
      expect(
        (await db.rpc<{ status: string }>('room_get', { room_id: crewRoom }, as('maya'))).status,
      ).toBe('ended')
    })

    it('non-member: Ben sees no Weekend Crew group, chat, Live or friends-only post', async () => {
      await db.expectError(
        db.rpc('group_get', { group_id: crew.groupId }, as('ben')),
        'not_a_member',
      )
      await db.expectError(
        db.rpc(
          'messages_list',
          { conversation_id: crew.conversationId, before_id: null, limit: 50 },
          as('ben'),
        ),
        'conversation_not_found',
      )
      await db.expectError(db.rpc('room_get', { room_id: crewRoom }, as('ben')), 'room_not_found')
      await db.expectError(
        db.rpc('post_get', { post_id: mayaFriendsPost }, as('ben')),
        'post_not_found',
      )
      expect((await search(db, 'weekend', as('ben'))).groups).toEqual([])
      expect((await search(db, 'weekend', as('sarah'))).groups.map((g) => g.name)).toEqual([
        'Weekend Crew',
      ])
    })

    it("friend: Sarah reads Maya's friends-only post and profile as a friend", async () => {
      const post = PostDetailDtoSchema.parse(
        await db.rpc('post_get', { post_id: mayaFriendsPost }, as('sarah')),
      )
      expect(post.post.audience).toBe('friends')
      expect(post.reactionCount).toBe(2)
      const profile = ProfileDtoSchema.parse(
        await db.rpc('profile_get', { handle: 'maya' }, as('sarah')),
      )
      expect(profile.relationship).toMatchObject({
        isFriend: true,
        isFollowing: false,
        isBlocked: false,
      })
      expect(profile.sharedGroupCount).toBe(1)
      expect(profile.canMessage).toBe(true)
      await db.expectError(
        db.rpc('post_get', { post_id: mayaFriendsPost }, as('alex')),
        'post_not_found',
      )
    })

    it('blocked: a block between two fixtures hides their World posts and profiles from each other until it is lifted', async () => {
      await db.rpc('block_set', { target_human_id: HUMAN.xavier, blocked: true }, as('ben'))
      try {
        await db.expectError(db.rpc('post_get', { post_id: sunrise }, as('ben')), 'post_not_found')
        await db.expectError(
          db.rpc('post_get', { post_id: benWorldPost }, as('xavier')),
          'post_not_found',
        )
        expect((await search(db, 'xavier', as('ben'))).people).toEqual([])
        expect((await search(db, 'ben', as('xavier'))).people.map((p) => p.handle)).toEqual([])
        expect(await feedWorld(db, as('ben'))).not.toContain(HUMAN.xavier)
        await db.expectError(db.rpc('profile_get', { handle: 'ben' }, as('xavier')), 'not_visible')
      } finally {
        await db.rpc('block_set', { target_human_id: HUMAN.xavier, blocked: false }, as('ben'))
      }
      expect(
        PostDetailDtoSchema.parse(await db.rpc('post_get', { post_id: sunrise }, as('ben'))).author
          .handle,
      ).toBe('xavier')
      expect(await feedWorld(db, as('ben'))).toEqual(sorted(fixtureIds))
      expect(await count(db, 'public.blocks')).toBe(0)
    })

    it('the documented tokens really admit a new Human (use_count and member_count move)', async () => {
      const newcomer = await createHuman(db, { handle: 'newcomerdev', displayName: 'Newcomer' })
      const joined = GroupJoinDtoSchema.parse(
        await db.rpc('group_invite_join', { token: TOKENS.weekendCrew }, newcomer.as),
      )
      expect(joined).toEqual({
        groupId: crew.groupId,
        conversationId: crew.conversationId,
        alreadyMember: false,
        isSecondGroup: false,
      })
      expect(
        await scalar(db, 'use_count from public.group_invites where group_id = $1', [crew.groupId]),
      ).toBe(4)
      expect((await preview(db, TOKENS.weekendCrew, 'visitor')).memberCount).toBe(5)
      expect((await messages(db, crew.conversationId, newcomer.as)).messages).toHaveLength(37)
      expect((await messages(db, crew.conversationId, newcomer.as)).messages[0]).toMatchObject({
        type: 'system',
        text: 'Newcomer joined',
      })
    })
  })
})
