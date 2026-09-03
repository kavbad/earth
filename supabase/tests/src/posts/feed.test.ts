/**
 * feed_candidates / public_feed (DB_API §4; spec §63–§70; ARCHITECTURE §9 step 1): the candidate
 * pools per scope, already permission-filtered (audience, blocks, hides, fixtures in production),
 * as `FeedCandidate` feature rows plus rendering payloads, with Lives reused from the rooms tier.
 */
import { FeedCandidateSchema, PostViewDtoSchema } from '@earth/domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  PublicFeedResultSchema,
  addMember,
  befriend,
  block,
  canSee,
  createArea,
  createGroup,
  createGuest,
  createHuman,
  createPost,
  createUnclaimed,
  feed,
  feedIds,
  human,
  postArgs,
  relate,
  resetRateLimits,
  rpcAt,
  setContext,
  setFlag,
  setHuman,
  setSetting,
  startGroupRoom,
  startStandaloneRoom,
  type FeedRow,
  type GroupFixture,
  type Human,
} from './fixtures'

describe('feed_candidates (spec §64–§69)', () => {
  let db: TestDb
  let sf: string
  let mission: string
  let marina: string
  let la: string
  let me: Human
  let friend: Human
  let followed: Human
  let groupmate: Human
  let stranger: Human
  let blockedFriend: Human
  let blocker: Human
  let fixture: Human
  let group: GroupFixture
  const posts: Record<string, string> = {}

  beforeAll(async () => {
    db = await createTestDb()
    sf = await createArea(db, { name: 'San Francisco', slug: 'sf', type: 'city' })
    mission = await createArea(db, {
      name: 'Mission',
      slug: 'mission',
      type: 'neighborhood',
      parentAreaId: sf,
    })
    marina = await createArea(db, {
      name: 'Marina',
      slug: 'marina',
      type: 'neighborhood',
      parentAreaId: sf,
    })
    la = await createArea(db, { name: 'Los Angeles', slug: 'la', type: 'city' })
    me = await human(db, 'Me')
    friend = await human(db, 'Friend')
    followed = await human(db, 'Followed')
    groupmate = await human(db, 'Groupmate')
    stranger = await human(db, 'Stranger')
    blockedFriend = await human(db, 'Blockedfriend')
    blocker = await human(db, 'Blocker')
    fixture = await human(db, 'Fixture')
    await setHuman(db, fixture, { isFixture: true })
    await befriend(db, me, friend)
    await befriend(db, me, blockedFriend)
    await befriend(db, me, blocker)
    await block(db, me, blockedFriend)
    await block(db, blocker, me)
    await relate(db, me, followed, 'follow')
    group = await createGroup(db, groupmate, 'Weekend Crew')
    await addMember(db, group, me)
    await setContext(db, me, { currentAreaId: mission, currentCityId: sf })
    await setContext(db, friend, { currentCityId: la })
    await setContext(db, followed, { currentCityId: la })
    await setContext(db, groupmate, { currentAreaId: mission, currentCityId: sf })
    await setContext(db, stranger, { currentAreaId: marina, currentCityId: sf })
    await setContext(db, fixture, { currentAreaId: mission, currentCityId: sf })

    const seed: Array<[string, Human, Parameters<typeof postArgs>[0]]> = [
      ['mine', me, { text: 'mine', audience: 'friends' }],
      ['friendFriends', friend, { text: 'friend friends', audience: 'friends' }],
      [
        'friendNeighborhood',
        friend,
        { text: 'friend nb in la', audience: 'neighborhood', areaId: la },
      ],
      ['friendWorld', friend, { text: 'friend world', audience: 'world' }],
      ['followedWorld', followed, { text: 'followed world', audience: 'world' }],
      ['followedFriends', followed, { text: 'followed friends', audience: 'friends' }],
      ['followedCityLa', followed, { text: 'followed la city', audience: 'city' }],
      ['groupmateWorld', groupmate, { text: 'groupmate world', audience: 'world' }],
      ['groupmateNeighborhood', groupmate, { text: 'groupmate mission', audience: 'neighborhood' }],
      ['strangerWorld', stranger, { text: 'stranger world', audience: 'world' }],
      ['strangerMarina', stranger, { text: 'stranger marina', audience: 'neighborhood' }],
      ['strangerCity', stranger, { text: 'stranger city', audience: 'city' }],
      [
        'strangerCityInMission',
        stranger,
        { text: 'stranger city tagged mission', audience: 'city', areaId: mission },
      ],
      ['blockedFriendWorld', blockedFriend, { text: 'blocked friend world', audience: 'world' }],
      [
        'blockedFriendFriends',
        blockedFriend,
        { text: 'blocked friend friends', audience: 'friends' },
      ],
      ['blockerWorld', blocker, { text: 'blocker world', audience: 'world' }],
      ['fixtureWorld', fixture, { text: 'fixture world', audience: 'world' }],
      ['fixtureNeighborhood', fixture, { text: 'fixture mission', audience: 'neighborhood' }],
    ]
    let minute = 0
    for (const [key, author, options] of seed) {
      minute += 1
      const at = new Date(Date.UTC(2026, 8, 1, 10, minute)).toISOString()
      const view = PostViewDtoSchema.parse(
        await rpcAt(db, 'post_create', postArgs(options), author.as, at),
      )
      posts[key] = view.post.id
    }
    // A reply never appears as a candidate of its own.
    const friendWorld = posts['friendWorld']
    if (friendWorld === undefined) throw new Error('seed missing')
    posts['replyToFriend'] = (
      await createPost(db, me, { text: 'reply', audience: 'world', parentPostId: friendWorld })
    ).post.id
  })

  afterAll(async () => {
    await db.drop()
  })

  beforeEach(async () => {
    await resetRateLimits(db)
  })

  const ids = (keys: string[]) =>
    keys
      .map((k) => {
        const id = posts[k]
        if (id === undefined) throw new Error(`unknown post ${k}`)
        return id
      })
      .sort()

  function rowsById(result: { candidates: FeedRow[] }): Map<string, FeedRow> {
    return new Map(result.candidates.map((c) => [c.id, c]))
  }

  describe('friends scope (spec §64)', () => {
    it('includes own posts, friends posts of any audience and followed Humans posts the viewer may see; excludes shared-group strangers, blocks and replies', async () => {
      const result = await feed(db, 'friends', me.as)
      expect(result).toMatchObject({ scope: 'friends', areaId: null, areaName: null })
      expect(result.candidates.map((c) => c.id).sort()).toEqual(
        ids(['mine', 'friendFriends', 'friendNeighborhood', 'friendWorld', 'followedWorld']),
      )
      const rows = rowsById(result)
      expect(rows.get(posts['friendFriends'] ?? '')).toMatchObject({
        kind: 'post',
        authorHumanId: friend.humanId,
        relationship: 'friend',
        sharedGroupCount: 0,
        isLive: false,
        liveParticipantCount: 0,
        liveFriendCount: 0,
        reactionCount: 0,
        replyCount: 0,
        authorPostCountRecent: 3,
        interestMatch: 0,
        placeAffinity: 0,
        hasSeen: false,
        audience: 'friends',
        areaId: null,
        startedAt: null,
      })
      expect(rows.get(posts['followedWorld'] ?? '')).toMatchObject({
        relationship: 'follow',
        authorPostCountRecent: 1,
      })
      expect(rows.get(posts['mine'] ?? '')).toMatchObject({
        relationship: 'friend',
        authorHumanId: me.humanId,
      })
      // Every row parses as a FeedCandidate and carries a PostViewDto payload.
      for (const row of result.candidates) {
        FeedCandidateSchema.parse(row)
        expect(PostViewDtoSchema.parse(row.post).post.id).toBe(row.id)
      }
      // Newest first.
      const createdAt = result.candidates.map((c) => c.createdAt)
      expect([...createdAt].sort().reverse()).toEqual(createdAt)
    })

    it('includes active Lives with direct friends and group Lives, with Live features and the rooms-tier payload', async () => {
      const friendsLive = await startStandaloneRoom(db, friend, 'Cooking')
      const groupLive = await startGroupRoom(db, groupmate, group)
      const strangerLive = await startStandaloneRoom(db, stranger)
      try {
        const result = await feed(db, 'friends', me.as)
        const lives = result.candidates.filter((c) => c.kind === 'live')
        expect(lives.map((c) => c.id).sort()).toEqual(
          [friendsLive.room.id, groupLive.room.id].sort(),
        )
        expect(lives.map((c) => c.id)).not.toContain(strangerLive.room.id)
        const rows = rowsById(result)
        const friendRow = rows.get(friendsLive.room.id)
        expect(friendRow).toMatchObject({
          kind: 'live',
          authorHumanId: null,
          relationship: 'friend',
          isLive: true,
          liveParticipantCount: 1,
          liveFriendCount: 1,
          reactionCount: 0,
          replyCount: 0,
          authorPostCountRecent: 0,
          audience: 'friends',
          areaId: null,
        })
        expect(friendRow?.startedAt).not.toBeNull()
        expect(friendRow?.live).toMatchObject({
          roomId: friendsLive.room.id,
          contextType: 'standalone',
          title: 'Cooking',
          visibility: 'friends',
          participantCount: 1,
        })
        expect(friendRow?.live?.participants[0]).toMatchObject({
          humanId: friend.humanId,
          relationToViewer: 'friend',
          mediaState: 'camera',
        })
        const groupRow = rows.get(groupLive.room.id)
        expect(groupRow).toMatchObject({
          kind: 'live',
          relationship: 'shared_group',
          sharedGroupCount: 1,
          liveFriendCount: 0,
          audience: 'friends',
        })
        expect(groupRow?.live).toMatchObject({
          contextType: 'group',
          contextTitle: 'Weekend Crew',
          visibility: 'group',
        })
        for (const row of lives) FeedCandidateSchema.parse(row)
        // Lives come first in the array; posts follow newest first.
        expect(result.candidates.slice(0, 2).every((c) => c.kind === 'live')).toBe(true)
      } finally {
        await db.rpc('room_end', { room_id: friendsLive.room.id }, friend.as)
        await db.rpc('room_end', { room_id: groupLive.room.id }, groupmate.as)
        await db.rpc('room_end', { room_id: strangerLive.room.id }, stranger.as)
      }
      expect((await feed(db, 'friends', me.as)).candidates.some((c) => c.kind === 'live')).toBe(
        false,
      )
    })

    it('a hidden post leaves the candidates but not post_get; a deleted post leaves both', async () => {
      const post = await createPost(db, friend, { text: 'hide or delete', audience: 'friends' })
      expect(await feedIds(db, 'friends', me.as)).toContain(post.post.id)
      await db.rpc('post_hide', { post_id: post.post.id }, me.as)
      expect(await feedIds(db, 'friends', me.as)).not.toContain(post.post.id)
      expect(await canSee(db, post.post.id, me.as)).toBe(true)
      // Hides are per viewer.
      const other = await human(db, 'Otherfriend')
      await befriend(db, friend, other)
      expect(await feedIds(db, 'friends', other.as)).toContain(post.post.id)
      await db.rpc('post_delete', { post_id: post.post.id }, friend.as)
      expect(await feedIds(db, 'friends', other.as)).not.toContain(post.post.id)
      expect(await canSee(db, post.post.id, other.as)).toBe(false)
    })

    it('requires a Human: visitors, guests, claiming and unclaimed credentials get not_authenticated', async () => {
      await db.expectError(
        db.rpc('feed_candidates', { scope: 'friends' }, 'visitor'),
        'not_authenticated',
      )
      await db.expectError(
        db.rpc('feed_candidates', { scope: 'friends' }, (await createGuest(db)).as),
        'not_authenticated',
      )
      await db.expectError(
        db.rpc('feed_candidates', { scope: 'friends' }, (await createUnclaimed(db)).as),
        'not_authenticated',
      )
      const pending = await createHuman(db, { handle: 'pendingfeed', status: 'pending' })
      await db.expectError(
        db.rpc('feed_candidates', { scope: 'friends' }, pending.as),
        'not_authenticated',
      )
      await db.expectError(db.rpc('feed_candidates', { scope: null }, me.as), 'invalid_input')
    })
  })

  describe('neighborhood and city scopes (spec §66–§67)', () => {
    it('neighborhood: posts tagged inside the browsed area that the viewer may see; area from context or explicit', async () => {
      const result = await feed(db, 'neighborhood', me.as)
      expect(result).toMatchObject({ scope: 'neighborhood', areaId: mission, areaName: 'Mission' })
      expect(result.candidates.map((c) => c.id).sort()).toEqual(
        ids(['groupmateNeighborhood', 'strangerCityInMission', 'fixtureNeighborhood']),
      )
      expect(rowsById(result).get(posts['groupmateNeighborhood'] ?? '')).toMatchObject({
        relationship: 'shared_group',
        sharedGroupCount: 1,
        placeAffinity: 1,
      })
      // The stranger in Marina browses Marina: their own post only (Mission posts do not reach them).
      expect(await feedIds(db, 'neighborhood', stranger.as)).toEqual(ids(['strangerMarina']))
      // Browsing Mission explicitly does not widen permissions: a neighborhood post of Mission stays out for a Human in Marina.
      expect(await feedIds(db, 'neighborhood', stranger.as, { areaId: mission })).toEqual(
        ids(['strangerCityInMission']),
      )
      const noContext = await human(db, 'Nocontext')
      await db.expectError(
        db.rpc('feed_candidates', { scope: 'neighborhood' }, noContext.as),
        'area_not_found',
      )
      await db.expectError(
        db.rpc(
          'feed_candidates',
          { scope: 'neighborhood', area_id: '00000000-0000-4000-8000-000000000000' },
          me.as,
        ),
        'area_not_found',
      )
      await setFlag(db, 'NEIGHBORHOOD_ENABLED', false)
      await db.expectError(
        db.rpc('feed_candidates', { scope: 'neighborhood' }, me.as),
        'feature_disabled',
      )
      await setFlag(db, 'NEIGHBORHOOD_ENABLED', true)
    })

    it('city: posts tagged inside the browsed city the viewer may see; the home city counts', async () => {
      const result = await feed(db, 'city', me.as)
      expect(result).toMatchObject({ scope: 'city', areaId: sf, areaName: 'San Francisco' })
      expect(result.candidates.map((c) => c.id).sort()).toEqual(
        ids([
          'groupmateNeighborhood',
          'strangerCity',
          'strangerCityInMission',
          'fixtureNeighborhood',
        ]),
      )
      expect(rowsById(result).get(posts['strangerCity'] ?? '')).toMatchObject({
        relationship: 'none',
        placeAffinity: 0.6,
        audience: 'city',
        areaId: sf,
      })
      // LA: the followed Human's city post is visible to a friend whose home city is LA.
      const homeInLa = await human(db, 'Homeinla')
      await setContext(db, homeInLa, { currentCityId: sf, homeCityId: la })
      expect(await feedIds(db, 'city', homeInLa.as, { areaId: la })).toEqual(
        ids(['followedCityLa']),
      )
      // Someone in SF browsing LA explicitly sees nothing they are not eligible for.
      expect(await feedIds(db, 'city', stranger.as, { areaId: la })).toEqual([])
      await setFlag(db, 'CITY_ENABLED', false)
      await db.expectError(db.rpc('feed_candidates', { scope: 'city' }, me.as), 'feature_disabled')
      await setFlag(db, 'CITY_ENABLED', true)
    })
  })

  describe('world scope and visitors (spec §68–§69)', () => {
    it('as a Human: world posts except blocked either way; a world Live is included', async () => {
      const result = await feed(db, 'world', me.as)
      expect(result.candidates.map((c) => c.id).sort()).toEqual(
        ids(['friendWorld', 'followedWorld', 'groupmateWorld', 'strangerWorld', 'fixtureWorld']),
      )
      expect(rowsById(result).get(posts['groupmateWorld'] ?? '')).toMatchObject({
        relationship: 'shared_group',
        sharedGroupCount: 1,
      })
      await setFlag(db, 'WORLD_ENABLED', false)
      await db.expectError(db.rpc('feed_candidates', { scope: 'world' }, me.as), 'feature_disabled')
      await setFlag(db, 'WORLD_ENABLED', true)
    })

    it('as a visitor: only world posts and public Lives — never friends, neighborhood or city posts', async () => {
      const host = await human(db, 'Host')
      await setContext(db, host, { currentAreaId: mission, currentCityId: sf })
      const worldLive = await startStandaloneRoom(db, host, 'Hello world')
      await db.rpc(
        'room_set_visibility',
        { room_id: worldLive.room.id, visibility: 'world' },
        host.as,
      )
      const friendsLive = await startStandaloneRoom(db, friend)
      try {
        const result = await feed(db, 'world', 'visitor')
        expect(result.candidates.map((c) => c.id).sort()).toEqual(
          [
            ...ids([
              'friendWorld',
              'followedWorld',
              'groupmateWorld',
              'strangerWorld',
              'blockedFriendWorld',
              'blockerWorld',
              'fixtureWorld',
            ]),
            worldLive.room.id,
          ].sort(),
        )
        const rows = rowsById(result)
        expect(rows.get(worldLive.room.id)).toMatchObject({
          kind: 'live',
          relationship: 'none',
          liveFriendCount: 0,
          liveParticipantCount: 1,
          audience: 'world',
          areaId: sf,
        })
        expect(rows.get(worldLive.room.id)?.live?.participants[0]).toMatchObject({
          relationToViewer: null,
        })
        for (const row of result.candidates) {
          FeedCandidateSchema.parse(row)
          if (row.kind === 'post') {
            expect(row.audience).toBe('world')
            expect(row.relationship).toBe('none')
            expect(row.post?.myReaction).toBeNull()
          }
        }
        expect(result.candidates.map((c) => c.id)).not.toContain(friendsLive.room.id)
        // Guests and claiming credentials browse World like visitors (without Lives for Guests).
        const guest = await createGuest(db)
        const asGuest = await feed(db, 'world', guest.as)
        expect(
          asGuest.candidates
            .filter((c) => c.kind === 'post')
            .map((c) => c.id)
            .sort(),
        ).toEqual(
          result.candidates
            .filter((c) => c.kind === 'post')
            .map((c) => c.id)
            .sort(),
        )
        expect(asGuest.candidates.some((c) => c.kind === 'live')).toBe(false)
        const pending = await createHuman(db, { handle: 'pendingworld', status: 'pending' })
        expect((await feed(db, 'world', pending.as)).candidates.map((c) => c.id).sort()).toEqual(
          result.candidates.map((c) => c.id).sort(),
        )
        // The service role reads the public pool.
        expect((await feed(db, 'world', 'service')).candidates.map((c) => c.id).sort()).toEqual(
          result.candidates.map((c) => c.id).sort(),
        )
        // Lives need PUBLIC_LIVE_ENABLED; posts do not.
        await setFlag(db, 'PUBLIC_LIVE_ENABLED', false)
        const noLive = await feed(db, 'world', 'visitor')
        expect(noLive.candidates.some((c) => c.kind === 'live')).toBe(false)
        expect(noLive.candidates.length).toBe(result.candidates.length - 1)
        await setFlag(db, 'PUBLIC_LIVE_ENABLED', true)
      } finally {
        await db.rpc('room_end', { room_id: worldLive.room.id }, host.as)
        await db.rpc('room_end', { room_id: friendsLive.room.id }, friend.as)
      }
    })

    it('PUBLIC_WORLD_ENABLED off closes World to visitors and guests, not to Humans', async () => {
      await setFlag(db, 'PUBLIC_WORLD_ENABLED', false)
      await db.expectError(
        db.rpc('feed_candidates', { scope: 'world' }, 'visitor'),
        'feature_disabled',
      )
      await db.expectError(
        db.rpc('feed_candidates', { scope: 'world' }, (await createGuest(db)).as),
        'feature_disabled',
      )
      await db.expectError(db.rpc('public_feed', {}, 'visitor'), 'feature_disabled')
      expect((await feed(db, 'world', me.as)).candidates.length).toBeGreaterThan(0)
      await setFlag(db, 'PUBLIC_WORLD_ENABLED', true)
    })

    it('fixture Humans never reach anyone when environment = production', async () => {
      expect(await feedIds(db, 'world', 'visitor')).toContain(posts['fixtureWorld'])
      expect(await feedIds(db, 'neighborhood', me.as)).toContain(posts['fixtureNeighborhood'])
      await setSetting(db, 'environment', 'production')
      expect(await feedIds(db, 'world', 'visitor')).not.toContain(posts['fixtureWorld'])
      expect(await feedIds(db, 'world', me.as)).not.toContain(posts['fixtureWorld'])
      expect(await feedIds(db, 'neighborhood', me.as)).not.toContain(posts['fixtureNeighborhood'])
      expect(
        PublicFeedResultSchema.parse(await db.rpc('public_feed', {}, 'visitor')).candidates.map(
          (c) => c.id,
        ),
      ).not.toContain(posts['fixtureWorld'])
      await setSetting(db, 'environment', 'development')
      expect(await feedIds(db, 'world', 'visitor')).toContain(posts['fixtureWorld'])
    })

    it('snapshot_at pins the candidate set and limit caps it', async () => {
      const before = new Date(Date.UTC(2026, 8, 1, 10, 3, 30)).toISOString()
      const pinned = await feed(db, 'world', 'visitor', { snapshotAt: before })
      expect(new Date(pinned.snapshotAt).toISOString()).toBe(before)
      // The first world post is friendWorld at 10:04: nothing qualifies at 10:03:30.
      expect(pinned.candidates.filter((c) => c.kind === 'post')).toEqual([])
      const upTo = new Date(Date.UTC(2026, 8, 1, 10, 5)).toISOString()
      expect(
        (await feed(db, 'world', 'visitor', { snapshotAt: upTo })).candidates
          .filter((c) => c.kind === 'post')
          .map((c) => c.id)
          .sort(),
      ).toEqual(ids(['friendWorld', 'followedWorld']))
      const limited = await feed(db, 'world', 'visitor', { limit: 2 })
      expect(limited.candidates.filter((c) => c.kind === 'post')).toHaveLength(2)
      expect(limited.candidates[0]?.id).toBe(posts['fixtureWorld'])
    })
  })

  describe('public_feed (spec §69; SCREEN 01)', () => {
    it('pages world posts newest first for visitors with a created_at cursor', async () => {
      const page1 = PublicFeedResultSchema.parse(
        await db.rpc('public_feed', { cursor: null, limit: 3 }, 'visitor'),
      )
      expect(page1.scope).toBe('world')
      expect(page1.candidates.map((c) => c.id)).toEqual([
        posts['fixtureWorld'],
        posts['blockerWorld'],
        posts['blockedFriendWorld'],
      ])
      expect(page1.nextCursor).toBe(page1.candidates[2]?.createdAt)
      const page2 = PublicFeedResultSchema.parse(
        await db.rpc('public_feed', { cursor: page1.nextCursor, limit: 3 }, 'visitor'),
      )
      expect(page2.candidates.map((c) => c.id)).toEqual([
        posts['strangerWorld'],
        posts['groupmateWorld'],
        posts['followedWorld'],
      ])
      const page3 = PublicFeedResultSchema.parse(
        await db.rpc('public_feed', { cursor: page2.nextCursor, limit: 3 }, 'visitor'),
      )
      expect(page3.candidates.map((c) => c.id)).toEqual([posts['friendWorld']])
      expect(page3.nextCursor).toBeNull()
      for (const row of [...page1.candidates, ...page2.candidates, ...page3.candidates]) {
        FeedCandidateSchema.parse(row)
        expect(row.kind).toBe('post')
        expect(row.audience).toBe('world')
      }
      // Humans get their own permission view (blocks apply).
      const mine = PublicFeedResultSchema.parse(
        await db.rpc('public_feed', { cursor: null, limit: 50 }, me.as),
      )
      expect(mine.candidates.map((c) => c.id)).not.toContain(posts['blockerWorld'])
      expect(mine.candidates.map((c) => c.id)).not.toContain(posts['blockedFriendWorld'])
    })
  })
})
