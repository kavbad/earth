/**
 * Blocks override everything (spec §21, §56, §128 "Blocks override all discovery"; 0740). After A
 * blocks B: messaging, feed eligibility in every scope, Live discovery (list, fetch, join, RLS),
 * search and profiles, notifications, location sharing and the map, friend edges — in both
 * directions where the rule is symmetric (`earth.is_blocked_either`). Group coexistence stays
 * possible (spec §56) and unblocking restores discovery.
 */
import { MapObjectsDtoSchema, RoomDtoSchema } from '@earth/domain'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  BASE_AREA_SLUGS,
  POINTS,
  addMember,
  areaBySlug,
  befriend,
  count,
  createGroup,
  createPost,
  createShare,
  directConversation,
  errorCode,
  feed,
  human,
  notificationsFor,
  relate,
  resetAllRateLimits,
  search,
  sendMessage,
  setContext,
  shareRow,
  startGroupRoom,
  startStandaloneRoom,
  visibleShares,
  type GroupFixture,
  type Human,
} from './fixtures'

const SCOPES = ['friends', 'neighborhood', 'city', 'world'] as const
const SF_BBOX = { min_lat: 37.6, min_lng: -122.6, max_lat: 37.9, max_lng: -122.3 } as const

interface LiveCandidate {
  roomId: string
  participants: Array<{ humanId: string | null }>
}

async function liveRoomIds(db: TestDb, scope: string, as: RoleSpec): Promise<string[]> {
  const list = await db.rpc<{ candidates: LiveCandidate[] }>(
    'live_candidates',
    { scope, area_id: null },
    as,
  )
  return list.candidates.map((c) => c.roomId).sort()
}

async function feedAuthorsAndLives(
  db: TestDb,
  scope: string,
  as: RoleSpec,
): Promise<{ authors: string[]; lives: string[] }> {
  const page = await feed(db, scope, as)
  return {
    authors: [
      ...new Set(
        page.candidates.filter((c) => c.kind === 'post').map((c) => c.authorHumanId ?? ''),
      ),
    ].sort(),
    lives: page.candidates
      .filter((c) => c.kind === 'live')
      .map((c) => c.id)
      .sort(),
  }
}

async function rowsAs<T extends Record<string, unknown>>(
  db: TestDb,
  as: RoleSpec,
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  return db.asRole(as, async (c) => (await c.query<T>(sql, values)).rows)
}

describe('block overrides (spec §21)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let carol: Human
  let crew: GroupFixture
  let northBeach: string
  let sanFrancisco: string
  let dm: string
  let alicePosts: Record<(typeof SCOPES)[number], string>
  let bobWorldPost: string
  let aliceGroupRoom: string
  let aliceWorldRoom: string
  let bobWorldRoom: string
  let aliceFriendShare: string
  let notificationsFromAliceBeforeBlock: number
  let idsFromAliceBeforeBlock: string[]

  const notificationsFromAlice = async () =>
    (await notificationsFor(db, bob)).filter((n) => n.actor_human_id === alice.humanId).length
  const notificationsFromBob = async () =>
    (await notificationsFor(db, alice)).filter((n) => n.actor_human_id === bob.humanId).length
  const idsFromAlice = async () =>
    (
      await db.sql.query<{ id: string }>(
        'select id from public.notifications where recipient_human_id = $1 and actor_human_id = $2 order by id',
        [bob.humanId, alice.humanId],
      )
    ).rows.map((r) => r.id)

  beforeAll(async () => {
    db = await createTestDb()
    alice = await human(db, 'Alice')
    bob = await human(db, 'Bob')
    carol = await human(db, 'Carol')
    northBeach = await areaBySlug(db, BASE_AREA_SLUGS.northBeach)
    sanFrancisco = await areaBySlug(db, BASE_AREA_SLUGS.sanFrancisco)
    for (const h of [alice, bob, carol])
      await setContext(db, h, {
        currentAreaId: northBeach,
        currentCityId: sanFrancisco,
        homeCityId: sanFrancisco,
      })
    await befriend(db, alice, bob)
    await befriend(db, alice, carol)
    await befriend(db, bob, carol)
    await relate(db, bob, alice, 'follow')
    await relate(db, alice, bob, 'follow')
    crew = await createGroup(db, alice, 'Weekend Crew')
    await addMember(db, crew, bob)
    await addMember(db, crew, carol)

    dm = await directConversation(db, alice, bob)
    await sendMessage(db, alice, dm, 'hi bob')
    alicePosts = {
      friends: (await createPost(db, alice, { audience: 'friends', text: 'alice friends' })).post
        .id,
      neighborhood: (
        await createPost(db, alice, {
          audience: 'neighborhood',
          areaId: northBeach,
          text: 'alice neighborhood',
        })
      ).post.id,
      city: (
        await createPost(db, alice, { audience: 'city', areaId: sanFrancisco, text: 'alice city' })
      ).post.id,
      world: (await createPost(db, alice, { audience: 'world', text: 'alice world zebra' })).post
        .id,
    }
    bobWorldPost = (await createPost(db, bob, { audience: 'world', text: 'bob world giraffe' }))
      .post.id

    aliceGroupRoom = (await startGroupRoom(db, alice, crew, 'Dinner')).room.id
    const standalone = await startStandaloneRoom(db, alice, 'Walk')
    aliceWorldRoom = standalone.room.id
    await db.rpc('room_set_visibility', { room_id: aliceWorldRoom, visibility: 'world' }, alice.as)
    const bobStandalone = await startStandaloneRoom(db, bob, 'Run')
    bobWorldRoom = bobStandalone.room.id
    await db.rpc('room_set_visibility', { room_id: bobWorldRoom, visibility: 'world' }, bob.as)

    aliceFriendShare = (
      await createShare(db, alice, { audienceId: bob.humanId, position: POINTS.northBeach })
    ).id
    await resetAllRateLimits(db)
  })

  beforeEach(async () => {
    await resetAllRateLimits(db)
  })

  afterAll(async () => {
    await db.drop()
  })

  describe('before the block (the surfaces really carry A to B)', () => {
    it('B sees A everywhere', async () => {
      expect((await feedAuthorsAndLives(db, 'friends', bob.as)).authors).toContain(alice.humanId)
      expect((await feedAuthorsAndLives(db, 'neighborhood', bob.as)).authors).toContain(
        alice.humanId,
      )
      expect((await feedAuthorsAndLives(db, 'city', bob.as)).authors).toContain(alice.humanId)
      expect((await feedAuthorsAndLives(db, 'world', bob.as)).authors).toContain(alice.humanId)
      expect(await liveRoomIds(db, 'friends', bob.as)).toEqual(
        expect.arrayContaining([aliceGroupRoom, aliceWorldRoom]),
      )
      expect(await liveRoomIds(db, 'world', bob.as)).toContain(aliceWorldRoom)
      expect(
        RoomDtoSchema.parse(await db.rpc('room_get', { room_id: aliceGroupRoom }, bob.as)).id,
      ).toBe(aliceGroupRoom)
      expect((await search(db, bob.as, 'Alice')).people.map((p) => p.humanId)).toContain(
        alice.humanId,
      )
      expect((await search(db, bob.as, 'zebra')).posts.map((p) => p.post.id)).toContain(
        alicePosts.world,
      )
      expect(
        (
          await db.rpc<{ identity: { humanId: string } }>(
            'profile_get',
            { handle: alice.handle },
            bob.as,
          )
        ).identity.humanId,
      ).toBe(alice.humanId)
      expect((await visibleShares(db, bob.as)).map((s) => s.humanId)).toContain(alice.humanId)
      const map = MapObjectsDtoSchema.parse(
        await db.rpc('map_objects', { scope: 'world', ...SF_BBOX }, bob.as),
      )
      expect(map.lives.map((l) => l.roomId)).toContain(aliceWorldRoom)
      notificationsFromAliceBeforeBlock = await notificationsFromAlice()
      expect(notificationsFromAliceBeforeBlock).toBeGreaterThan(0)
    })
  })

  describe('after A blocks B', () => {
    beforeAll(async () => {
      idsFromAliceBeforeBlock = await idsFromAlice()
      const result = await db.rpc<{ isBlocked: boolean; isFriend: boolean; isFollowing: boolean }>(
        'block_set',
        { target_human_id: bob.humanId },
        alice.as,
      )
      expect(result).toMatchObject({ isBlocked: true, isFriend: false, isFollowing: false })
      await resetAllRateLimits(db)
    })

    it('friend suggestions have nothing to build on: every edge between A and B is gone, both ways', async () => {
      expect(
        await count(
          db,
          'public.relationships',
          '(source_human_id = $1 and target_human_id = $2) or (source_human_id = $2 and target_human_id = $1)',
          [alice.humanId, bob.humanId],
        ),
      ).toBe(0)
      expect(
        await count(db, 'public.blocks', 'blocker_human_id = $1 and blocked_human_id = $2', [
          alice.humanId,
          bob.humanId,
        ]),
      ).toBe(1)
      // C keeps both friendships: a block is strictly between the pair.
      expect(
        await count(db, 'public.relationships', "type = 'friend' and source_human_id = $1", [
          carol.humanId,
        ]),
      ).toBe(2)
    })

    describe('messaging (spec §56)', () => {
      it('B cannot message A: sends, opening the DM and reading it are blocked', async () => {
        expect(
          await errorCode(
            db.rpc(
              'message_send',
              { conversation_id: dm, client_id: randomUUID(), type: 'text', text: 'let me in' },
              bob.as,
            ),
          ),
        ).toBe('blocked')
        expect(
          await errorCode(
            db.rpc('conversation_direct_get_or_create', { other_human_id: alice.humanId }, bob.as),
          ),
        ).toBe('blocked')
        expect(await errorCode(db.rpc('messages_list', { conversation_id: dm }, bob.as))).toBe(
          'blocked',
        )
        expect(
          await rowsAs(db, bob.as, 'select id from public.messages where conversation_id = $1', [
            dm,
          ]),
        ).toEqual([])
        expect(await count(db, 'public.messages', 'conversation_id = $1', [dm])).toBe(1)
      })

      it('A cannot message B either (symmetric)', async () => {
        expect(
          await errorCode(
            db.rpc(
              'message_send',
              { conversation_id: dm, client_id: randomUUID(), type: 'text', text: 'nope' },
              alice.as,
            ),
          ),
        ).toBe('blocked')
        expect(
          await errorCode(
            db.rpc('conversation_direct_get_or_create', { other_human_id: bob.humanId }, alice.as),
          ),
        ).toBe('blocked')
        expect(
          await rowsAs(db, alice.as, 'select id from public.messages where conversation_id = $1', [
            dm,
          ]),
        ).toEqual([])
      })

      it('group membership coexists: both stay members and can post to the group, without notifying each other', async () => {
        expect(
          await count(
            db,
            'public.group_members',
            "group_id = $1 and status = 'active' and human_id in ($2, $3)",
            [crew.groupId, alice.humanId, bob.humanId],
          ),
        ).toBe(2)
        const before = {
          toBob: await notificationsFromAlice(),
          toAlice: await notificationsFromBob(),
          toCarol: (await notificationsFor(db, carol)).length,
        }
        const fromBob = await sendMessage(db, bob, crew.conversationId, 'still here')
        const fromAlice = await sendMessage(db, alice, crew.conversationId, 'me too')
        expect(await notificationsFromAlice()).toBe(before.toBob)
        expect(await notificationsFromBob()).toBe(before.toAlice)
        expect((await notificationsFor(db, carol)).length).toBe(before.toCarol + 2)
        const asAlice = await db.rpc<{ messages: Array<{ id: string }> }>(
          'messages_list',
          { conversation_id: crew.conversationId },
          alice.as,
        )
        expect(asAlice.messages.map((m) => m.id)).toEqual(
          expect.arrayContaining([fromBob, fromAlice]),
        )
      })
    })

    describe('feed eligibility', () => {
      it.each(SCOPES)("B does not see A's posts or Lives in the %s scope", async (scope) => {
        const { authors, lives } = await feedAuthorsAndLives(db, scope, bob.as)
        expect(authors).not.toContain(alice.humanId)
        expect(lives).not.toContain(aliceGroupRoom)
        expect(lives).not.toContain(aliceWorldRoom)
      })

      it.each(SCOPES)(
        "A does not see B's posts or Lives in the %s scope (symmetric)",
        async (scope) => {
          const { authors, lives } = await feedAuthorsAndLives(db, scope, alice.as)
          expect(authors).not.toContain(bob.humanId)
          expect(lives).not.toContain(bobWorldRoom)
        },
      )

      it('C still sees both, and the public feed hides A from B', async () => {
        expect((await feedAuthorsAndLives(db, 'world', carol.as)).authors).toEqual(
          expect.arrayContaining([alice.humanId, bob.humanId]),
        )
        const page = await db.rpc<{ candidates: Array<{ authorHumanId: string | null }> }>(
          'public_feed',
          {},
          bob.as,
        )
        expect(page.candidates.map((c) => c.authorHumanId)).not.toContain(alice.humanId)
        expect(
          await rowsAs(db, bob.as, 'select id from public.posts where author_human_id = $1', [
            alice.humanId,
          ]),
        ).toEqual([])
        expect(
          await rowsAs(db, alice.as, 'select id from public.posts where author_human_id = $1', [
            bob.humanId,
          ]),
        ).toEqual([])
      })

      it("B cannot fetch, react to or reply to A's posts", async () => {
        expect(await errorCode(db.rpc('post_get', { post_id: alicePosts.world }, bob.as))).toBe(
          'post_not_found',
        )
        expect(
          await errorCode(
            db.rpc(
              'post_reaction_set',
              { post_id: alicePosts.world, reaction_type: 'like' },
              bob.as,
            ),
          ),
        ).toBe('post_not_found')
        expect(
          await errorCode(
            db.rpc(
              'post_create',
              { type: 'text', text: 'reply', audience: 'world', parent_post_id: alicePosts.world },
              bob.as,
            ),
          ),
        ).toBe('post_not_found')
        expect(await errorCode(db.rpc('post_get', { post_id: bobWorldPost }, alice.as))).toBe(
          'post_not_found',
        )
      })
    })

    describe('Live discovery', () => {
      it.each(SCOPES)("A's Lives are absent from B's live_candidates(%s)", async (scope) => {
        const ids = await liveRoomIds(db, scope, bob.as)
        expect(ids).not.toContain(aliceGroupRoom)
        expect(ids).not.toContain(aliceWorldRoom)
      })

      it('room_get raises room_not_found for B, room_join too; the rows are invisible under RLS', async () => {
        expect(await errorCode(db.rpc('room_get', { room_id: aliceGroupRoom }, bob.as))).toBe(
          'room_not_found',
        )
        expect(await errorCode(db.rpc('room_get', { room_id: aliceWorldRoom }, bob.as))).toBe(
          'room_not_found',
        )
        expect(
          await errorCode(
            db.rpc(
              'room_join',
              { room_id: aliceGroupRoom, media_state: 'watching', consent_level: 'invited' },
              bob.as,
            ),
          ),
        ).toBe('room_not_found')
        expect(
          await errorCode(
            db.rpc(
              'room_join',
              { room_id: aliceWorldRoom, media_state: 'watching', consent_level: 'invited' },
              bob.as,
            ),
          ),
        ).toBe('room_not_found')
        expect(
          await rowsAs(db, bob.as, 'select id from public.rooms where id in ($1, $2)', [
            aliceGroupRoom,
            aliceWorldRoom,
          ]),
        ).toEqual([])
        expect(
          await rowsAs(db, bob.as, 'select id from public.room_participants where human_id = $1', [
            alice.humanId,
          ]),
        ).toEqual([])
      })

      it("B's Live is absent for A (symmetric); C and visitors still see the public Lives", async () => {
        expect(await liveRoomIds(db, 'world', alice.as)).not.toContain(bobWorldRoom)
        expect(await errorCode(db.rpc('room_get', { room_id: bobWorldRoom }, alice.as))).toBe(
          'room_not_found',
        )
        expect(await liveRoomIds(db, 'world', carol.as)).toEqual(
          expect.arrayContaining([aliceWorldRoom, bobWorldRoom]),
        )
        expect(await liveRoomIds(db, 'friends', carol.as)).toContain(aliceGroupRoom)
        expect(await liveRoomIds(db, 'world', 'visitor')).toEqual(
          expect.arrayContaining([aliceWorldRoom, bobWorldRoom]),
        )
      })

      it('the map shows B no Live of A and no share from A', async () => {
        const map = MapObjectsDtoSchema.parse(
          await db.rpc('map_objects', { scope: 'world', ...SF_BBOX }, bob.as),
        )
        expect(map.lives.map((l) => l.roomId)).not.toContain(aliceWorldRoom)
        expect(map.friends.map((f) => f.humanId)).not.toContain(alice.humanId)
        const forCarol = MapObjectsDtoSchema.parse(
          await db.rpc('map_objects', { scope: 'world', ...SF_BBOX }, carol.as),
        )
        expect(forCarol.lives.map((l) => l.roomId)).toEqual(
          expect.arrayContaining([aliceWorldRoom, bobWorldRoom]),
        )
      })
    })

    describe('search and profiles', () => {
      it('search(B) does not return A, in people or posts; A does not find B', async () => {
        const forBob = await search(db, bob.as, 'Alice')
        expect(forBob.people.map((p) => p.humanId)).not.toContain(alice.humanId)
        expect((await search(db, bob.as, 'zebra')).posts.map((p) => p.post.id)).not.toContain(
          alicePosts.world,
        )
        expect((await search(db, alice.as, 'Bob')).people.map((p) => p.humanId)).not.toContain(
          bob.humanId,
        )
        expect((await search(db, alice.as, 'giraffe')).posts.map((p) => p.post.id)).not.toContain(
          bobWorldPost,
        )
        expect((await search(db, carol.as, 'Alice')).people.map((p) => p.humanId)).toContain(
          alice.humanId,
        )
        expect((await search(db, carol.as, 'Bob')).people.map((p) => p.humanId)).toContain(
          bob.humanId,
        )
      })

      it('profiles are hidden both ways, at the RPC and under RLS', async () => {
        expect(await errorCode(db.rpc('profile_get', { handle: alice.handle }, bob.as))).toBe(
          'not_visible',
        )
        expect(await errorCode(db.rpc('profile_get', { handle: bob.handle }, alice.as))).toBe(
          'not_visible',
        )
        expect(
          await rowsAs(
            db,
            bob.as,
            'select human_id from public.public_identities where human_id = $1',
            [alice.humanId],
          ),
        ).toEqual([])
        expect(
          await rowsAs(
            db,
            alice.as,
            'select human_id from public.public_identities where human_id = $1',
            [bob.humanId],
          ),
        ).toEqual([])
        // Being blocked is never revealed to B, but A sees their own block.
        expect(await rowsAs(db, bob.as, 'select blocker_human_id from public.blocks')).toEqual([])
        expect(
          (await rowsAs(db, alice.as, 'select blocked_human_id from public.blocks')).map(
            (r) => r['blocked_human_id'],
          ),
        ).toEqual([bob.humanId])
      })
    })

    describe('notifications', () => {
      it('B receives no notification from A: friend request, follow, group Live, group message', async () => {
        const before = await notificationsFromAlice()
        expect(
          await errorCode(
            db.rpc('friend_request_send', { target_human_id: bob.humanId }, alice.as),
          ),
        ).toBe('blocked')
        expect(
          await errorCode(
            db.rpc('follow_set', { target_human_id: bob.humanId, following: true }, alice.as),
          ),
        ).toBe('blocked')
        await db.rpc('room_end', { room_id: aliceGroupRoom }, alice.as)
        const carolBefore = (await notificationsFor(db, carol)).filter(
          (n) => n.type === 'group_live',
        ).length
        aliceGroupRoom = (await startGroupRoom(db, alice, crew, 'Again')).room.id
        expect(
          (await notificationsFor(db, carol)).filter((n) => n.type === 'group_live').length,
        ).toBe(carolBefore + 1)
        await sendMessage(db, alice, crew.conversationId, 'group ping')
        expect(await notificationsFromAlice()).toBe(before)
        expect(await notificationsFromAlice()).toBe(notificationsFromAliceBeforeBlock)
        // Nothing new from A reaches B's list or the push queue (rows from before the block are history).
        expect(await idsFromAlice()).toEqual(idsFromAliceBeforeBlock)
        const queued = await db.rpc<
          Array<{ id: string; recipientHumanId: string; actorHumanId: string | null }>
        >('notifications_unsent', { limit: 500 }, 'service')
        expect(
          queued.filter(
            (n) =>
              n.recipientHumanId === bob.humanId &&
              n.actorHumanId === alice.humanId &&
              !idsFromAliceBeforeBlock.includes(n.id),
          ),
        ).toEqual([])
      })

      it('A receives none from B (symmetric)', async () => {
        const before = await notificationsFromBob()
        expect(
          await errorCode(
            db.rpc('friend_request_send', { target_human_id: alice.humanId }, bob.as),
          ),
        ).toBe('blocked')
        expect(
          await errorCode(
            db.rpc('follow_set', { target_human_id: alice.humanId, following: true }, bob.as),
          ),
        ).toBe('blocked')
        await sendMessage(db, bob, crew.conversationId, 'group pong')
        expect(await notificationsFromBob()).toBe(before)
      })
    })

    describe('location visibility', () => {
      it("A's friend share to B was revoked by the block and nothing of A is visible to B", async () => {
        expect((await shareRow(db, aliceFriendShare))?.revoked_at).not.toBeNull()
        expect((await visibleShares(db, bob.as)).map((s) => s.humanId)).not.toContain(alice.humanId)
        expect(
          await errorCode(
            db.rpc(
              'location_share_create',
              {
                audience_type: 'friend',
                audience_id: bob.humanId,
                precision: 'precise',
                duration_seconds: 3600,
                lat: POINTS.northBeach.lat,
                lng: POINTS.northBeach.lng,
              },
              alice.as,
            ),
          ),
        ).toBe('blocked')
        expect(
          await errorCode(
            db.rpc(
              'location_share_create',
              {
                audience_type: 'friend',
                audience_id: alice.humanId,
                precision: 'precise',
                duration_seconds: 3600,
                lat: POINTS.northBeach.lat,
                lng: POINTS.northBeach.lng,
              },
              bob.as,
            ),
          ),
        ).toBe('blocked')
      })

      it('group shares reach the other members but never cross the block, both ways', async () => {
        await createShare(db, alice, {
          audienceType: 'group',
          audienceId: crew.groupId,
          precision: 'approximate',
          position: POINTS.northBeach,
        })
        await createShare(db, bob, {
          audienceType: 'group',
          audienceId: crew.groupId,
          precision: 'approximate',
          position: POINTS.mission,
        })
        expect((await visibleShares(db, carol.as)).map((s) => s.humanId).sort()).toEqual(
          [alice.humanId, bob.humanId].sort(),
        )
        expect((await visibleShares(db, bob.as)).map((s) => s.humanId)).not.toContain(alice.humanId)
        expect((await visibleShares(db, alice.as)).map((s) => s.humanId)).not.toContain(bob.humanId)
        const map = MapObjectsDtoSchema.parse(
          await db.rpc('map_objects', { scope: 'friends', ...SF_BBOX }, bob.as),
        )
        expect(map.friends.map((f) => f.humanId)).not.toContain(alice.humanId)
      })
    })

    describe('unblocking', () => {
      it('restores discovery (not the friendship) and messaging', async () => {
        await db.rpc('block_set', { target_human_id: bob.humanId, blocked: false }, alice.as)
        await resetAllRateLimits(db)
        expect((await feedAuthorsAndLives(db, 'world', bob.as)).authors).toContain(alice.humanId)
        expect(await liveRoomIds(db, 'world', bob.as)).toContain(aliceWorldRoom)
        expect((await search(db, bob.as, 'Alice')).people.map((p) => p.humanId)).toContain(
          alice.humanId,
        )
        expect(
          (
            await db.rpc<{ identity: { humanId: string }; relationship: { isFriend: boolean } }>(
              'profile_get',
              { handle: alice.handle },
              bob.as,
            )
          ).relationship.isFriend,
        ).toBe(false)
        expect(
          await errorCode(
            db.rpc(
              'message_send',
              { conversation_id: dm, client_id: randomUUID(), type: 'text', text: 'hello again' },
              bob.as,
            ),
          ),
        ).toBeNull()
        expect(
          await count(
            db,
            'public.relationships',
            "type = 'friend' and source_human_id = $1 and target_human_id = $2",
            [alice.humanId, bob.humanId],
          ),
        ).toBe(0)
      })
    })
  })
})
