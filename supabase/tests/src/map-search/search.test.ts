/**
 * search (SCREEN 21; DB_API §9; spec §21, §43, §83, §128 "Blocks override all discovery"): one
 * universal query over people, groups, places and posts. People rank exact handle / name, friend,
 * mutual friends, group overlap, same city, then relevance; blocked (either way), hidden and pending
 * Humans never appear; groups only for members; posts only when visible; visitors get people
 * (public profiles) and places; 60 searches per minute.
 */
import { SEARCH_SECTION_SIZE } from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  BASE_AREA_SLUGS,
  addMember,
  areaBySlug,
  befriend,
  block,
  createGroup,
  createGuest,
  createHuman,
  createPlace,
  createPost,
  createPrivatePlace,
  createUnclaimed,
  human,
  placeByKey,
  relate,
  search,
  setContext,
  setGroupStatus,
  setHomeCity,
  setHuman,
  setSetting,
  type GroupFixture,
  type Human,
} from './fixtures'

describe('search (SCREEN 21)', () => {
  let db: TestDb
  let sf: string
  let la: string
  let mission: string
  let me: Human
  let exactHandle: Human
  let exactName: Human
  let friend: Human
  let mutualTwo: Human
  let mutualOne: Human
  let groupmate: Human
  let sameCity: Human
  let similar: Human
  let blockedByMe: Human
  let blocker: Human
  let hidden: Human
  let pending: Human
  let limited: Human
  let fixture: Human
  let restricted: Human
  let stranger: Human
  let guest: RoleSpec
  let claiming: RoleSpec
  let unclaimed: RoleSpec
  let crew: GroupFixture
  let club: GroupFixture
  let outsiders: GroupFixture
  let archived: GroupFixture
  let blockedOwners: GroupFixture

  const peopleIds = (results: { people: Array<{ humanId: string }> }) =>
    results.people.map((p) => p.humanId)
  const groupIds = (results: { groups: Array<{ groupId: string }> }) =>
    results.groups.map((g) => g.groupId).sort()
  const placeIds = (results: { places: Array<{ placeId: string }> }) =>
    results.places.map((p) => p.placeId).sort()
  const postIds = (results: { posts: Array<{ post: { id: string } }> }) =>
    results.posts.map((p) => p.post.id).sort()

  beforeAll(async () => {
    db = await createTestDb()
    sf = await areaBySlug(db, BASE_AREA_SLUGS.sanFrancisco)
    la = await areaBySlug(db, BASE_AREA_SLUGS.losAngeles)
    mission = await areaBySlug(db, BASE_AREA_SLUGS.mission)

    me = await createHuman(db, { handle: 'mayasearcher', displayName: 'Maya Self' })
    await setHomeCity(db, me, sf, true)
    await setContext(db, me, { currentCityId: sf, homeCityId: sf })

    exactHandle = await createHuman(db, { handle: 'maya', displayName: 'Zed Person' })
    exactName = await createHuman(db, { handle: 'zedperson', displayName: 'Maya' })
    friend = await createHuman(db, { handle: 'mayafriend', displayName: 'Maya Friend' })
    mutualTwo = await createHuman(db, { handle: 'mayamutualtwo', displayName: 'Maya Mutual Two' })
    mutualOne = await createHuman(db, { handle: 'mayamutualone', displayName: 'Maya Mutual One' })
    groupmate = await createHuman(db, { handle: 'mayagroup', displayName: 'Maya Group' })
    sameCity = await createHuman(db, { handle: 'mayacity', displayName: 'Maya City' })
    similar = await createHuman(db, { handle: 'mayazeta', displayName: 'Maya Zeta' })
    blockedByMe = await createHuman(db, { handle: 'mayablocked', displayName: 'Maya Blocked' })
    blocker = await createHuman(db, { handle: 'mayablocker', displayName: 'Maya Blocker' })
    hidden = await createHuman(db, {
      handle: 'mayahidden',
      displayName: 'Maya Hidden',
      visibility: 'hidden',
    })
    pending = await createHuman(db, {
      handle: 'mayapending',
      displayName: 'Maya Pending',
      status: 'pending',
    })
    limited = await createHuman(db, {
      handle: 'mayalimited',
      displayName: 'Maya Limited',
      visibility: 'limited',
    })
    fixture = await createHuman(db, { handle: 'mayafixture', displayName: 'Maya Fixture' })
    await setHuman(db, fixture, { isFixture: true })
    restricted = await createHuman(db, {
      handle: 'mayarestricted',
      displayName: 'Maya Restricted',
      status: 'restricted',
    })
    stranger = await createHuman(db, { handle: 'stranger', displayName: 'Someone Else' })

    // Friend graph: friend; two mutual friends (Mike, Nina) for mutualTwo, one for mutualOne.
    const mike = await human(db, 'Mike')
    const nina = await human(db, 'Nina')
    await befriend(db, me, friend)
    await befriend(db, me, mike)
    await befriend(db, me, nina)
    await befriend(db, mutualTwo, mike)
    await befriend(db, mutualTwo, nina)
    await befriend(db, mutualOne, mike)
    await befriend(db, me, hidden)
    await befriend(db, me, blockedByMe)
    await relate(db, me, similar, 'follow')
    await block(db, me, blockedByMe)
    await block(db, blocker, me)

    // Cities: sameCity shares San Francisco publicly; similar lives there too but keeps it private.
    await setHomeCity(db, sameCity, sf, true)
    await setHomeCity(db, similar, sf, false)
    await setHomeCity(db, exactHandle, la, true)

    // Groups.
    crew = await createGroup(db, me, 'Maya Crew')
    await addMember(db, crew, groupmate)
    club = await createGroup(db, stranger, 'Mayan Club')
    await addMember(db, club, me)
    outsiders = await createGroup(db, stranger, 'Maya Outsiders')
    archived = await createGroup(db, me, 'Maya Archived')
    await setGroupStatus(db, archived.groupId, 'archived')
    blockedOwners = await createGroup(db, blocker, 'Maya Blocked Owner')
    await addMember(db, blockedOwners, me)

    guest = (await createGuest(db)).as
    claiming = (await createHuman(db, { handle: 'claiming', status: 'pending' })).as
    unclaimed = (await createUnclaimed(db)).as
  })

  afterAll(async () => {
    await db.drop()
  })

  describe('input', () => {
    it('rejects an empty or over-long query and clamps the limit', async () => {
      await db.expectError(db.rpc('search', { q: '', limit: 10 }, me.as), 'invalid_input')
      await db.expectError(db.rpc('search', { q: '   ', limit: 10 }, me.as), 'invalid_input')
      await db.expectError(db.rpc('search', { q: null, limit: 10 }, me.as), 'invalid_input')
      await db.expectError(
        db.rpc('search', { q: 'm'.repeat(101), limit: 10 }, me.as),
        'invalid_input',
      )
      expect((await search(db, 'm'.repeat(100), me.as)).people).toEqual([])
      expect((await search(db, 'maya', me.as, 1)).people).toHaveLength(1)
      expect((await search(db, 'maya', me.as, 0)).people).toHaveLength(1)
      expect((await search(db, 'maya', me.as, 1000)).people.length).toBeGreaterThan(1)
      expect((await search(db, 'maya', me.as, null)).people.length).toBeLessThanOrEqual(
        SEARCH_SECTION_SIZE,
      )
    })
  })

  describe('people', () => {
    it('ranks exact handle / name, friend, mutual count, group overlap, same city, then similarity', async () => {
      const results = await search(db, 'maya', me.as, 20)
      const ids = peopleIds(results)
      // Both exact matches lead (handle `maya` and display name `Maya`).
      expect(ids.slice(0, 2).sort()).toEqual([exactHandle.humanId, exactName.humanId].sort())
      expect(ids.slice(2, 8)).toEqual([
        friend.humanId,
        mutualTwo.humanId,
        mutualOne.humanId,
        groupmate.humanId,
        sameCity.humanId,
        similar.humanId,
      ])
      expect(results.people.find((p) => p.humanId === friend.humanId)).toEqual({
        humanId: friend.humanId,
        displayName: 'Maya Friend',
        handle: 'mayafriend',
        avatarUrl: null,
        mutualFriendCount: 0,
        cityName: null,
        isFriend: true,
        isFollowing: false,
      })
      expect(results.people.find((p) => p.humanId === mutualTwo.humanId)).toMatchObject({
        mutualFriendCount: 2,
        isFriend: false,
      })
      expect(results.people.find((p) => p.humanId === mutualOne.humanId)).toMatchObject({
        mutualFriendCount: 1,
      })
      expect(results.people.find((p) => p.humanId === sameCity.humanId)).toMatchObject({
        cityName: 'San Francisco',
      })
      expect(results.people.find((p) => p.humanId === similar.humanId)).toMatchObject({
        cityName: null,
        isFollowing: true,
      })
      expect(results.people.find((p) => p.humanId === exactHandle.humanId)).toMatchObject({
        cityName: 'Los Angeles',
      })
      // A friend with a lower-relevance name still outranks a stranger with an exact-prefix name.
      expect(ids.indexOf(friend.humanId)).toBeLessThan(ids.indexOf(similar.humanId))
    })

    it('finds by handle with an @, by display-name substring and by trigram similarity', async () => {
      expect(peopleIds(await search(db, '@maya', me.as))[0]).toBe(exactHandle.humanId)
      expect(
        peopleIds(await search(db, 'MAYA', me.as))
          .slice(0, 2)
          .sort(),
      ).toEqual([exactHandle.humanId, exactName.humanId].sort())
      // Substring match first, then the trigram neighbour ("Maya Mutual One").
      expect(peopleIds(await search(db, 'mutual two', me.as))).toEqual([
        mutualTwo.humanId,
        mutualOne.humanId,
      ])
      expect(peopleIds(await search(db, 'Maya Mutal Two', me.as))[0]).toBe(mutualTwo.humanId)
      expect(peopleIds(await search(db, 'Zed', me.as))).toEqual([
        exactHandle.humanId,
        exactName.humanId,
      ])
      expect(peopleIds(await search(db, 'xyzzy', me.as))).toEqual([])
      // LIKE metacharacters are literal.
      expect(peopleIds(await search(db, '%', me.as))).toEqual([])
      expect(peopleIds(await search(db, '_', me.as))).toEqual([])
    })

    it('never lists blocked (either way), hidden, pending, restricted Humans or the caller', async () => {
      const ids = peopleIds(await search(db, 'maya', me.as, 50))
      expect(ids).not.toContain(me.humanId)
      expect(ids).not.toContain(blockedByMe.humanId)
      expect(ids).not.toContain(blocker.humanId)
      expect(ids).not.toContain(hidden.humanId)
      expect(ids).not.toContain(pending.humanId)
      expect(ids).not.toContain(restricted.humanId)
      expect(ids).toContain(limited.humanId)
      expect(ids).toContain(fixture.humanId)
      // Hidden stays hidden from a friend's search too; the blocked pair see nothing of each other.
      expect(peopleIds(await search(db, 'hidden', me.as))).toEqual([])
      expect(peopleIds(await search(db, 'maya', blockedByMe.as, 50))).not.toContain(me.humanId)
      expect(peopleIds(await search(db, 'maya', blocker.as, 50))).not.toContain(me.humanId)
      expect(peopleIds(await search(db, 'searcher', friend.as))).toEqual([me.humanId])
    })

    it('visitors, Guests, claiming and unclaimed credentials see public profiles only (no fixtures in production)', async () => {
      for (const as of ['visitor' as const, guest, claiming, unclaimed]) {
        const results = await search(db, 'maya', as, 50)
        const ids = peopleIds(results)
        expect(ids.slice(0, 2).sort()).toEqual([exactHandle.humanId, exactName.humanId].sort())
        expect(ids).toContain(friend.humanId)
        expect(ids).toContain(fixture.humanId)
        expect(ids).not.toContain(limited.humanId)
        expect(ids).not.toContain(hidden.humanId)
        expect(ids).not.toContain(pending.humanId)
        expect(
          results.people.every((p) => !p.isFriend && !p.isFollowing && p.mutualFriendCount === 0),
        ).toBe(true)
        expect(results.groups).toEqual([])
        expect(results.posts).toEqual([])
      }
      await setSetting(db, 'environment', 'production')
      expect(peopleIds(await search(db, 'maya', 'visitor', 50))).not.toContain(fixture.humanId)
      expect(peopleIds(await search(db, 'maya', me.as, 50))).toContain(fixture.humanId)
      await setSetting(db, 'environment', 'development')
    })
  })

  describe('groups', () => {
    it('lists only active groups the caller is a member of, never one owned by a blocked Human', async () => {
      const results = await search(db, 'maya', me.as)
      expect(groupIds(results)).toEqual([crew.groupId, club.groupId].sort())
      expect(results.groups.find((g) => g.groupId === crew.groupId)).toEqual({
        groupId: crew.groupId,
        name: 'Maya Crew',
        avatarUrl: null,
        memberCount: 2,
        isMember: true,
      })
      expect(groupIds(await search(db, 'maya', stranger.as))).toEqual(
        [club.groupId, outsiders.groupId].sort(),
      )
      expect(groupIds(await search(db, 'outsiders', me.as))).toEqual([])
      expect(groupIds(await search(db, 'archived', me.as))).toEqual([])
      expect(groupIds(await search(db, 'blocked owner', me.as))).toEqual([])
      expect(groupIds(await search(db, 'blocked owner', blocker.as))).toEqual([
        blockedOwners.groupId,
      ])
      expect(groupIds(await search(db, 'crew', groupmate.as))).toEqual([crew.groupId])
      expect((await search(db, 'crew', me.as)).groups[0]?.name).toBe('Maya Crew')
      // Exact name first.
      expect((await search(db, 'Mayan Club', me.as)).groups.map((g) => g.name)).toEqual([
        'Mayan Club',
        'Maya Crew',
      ])
    })
  })

  describe('places', () => {
    let cafe: string
    let secret: string
    let mine: string

    beforeAll(async () => {
      cafe = await createPlace(db, mission, 'Maya Cafe')
      secret = await createPrivatePlace(db, stranger, mission, 'Maya Secret')
      mine = await createPrivatePlace(db, me, mission, 'Maya Mine')
    })

    it('matches public Places by name (plus the caller’s own private ones), for everyone', async () => {
      const results = await search(db, 'maya', me.as)
      expect(placeIds(results)).toEqual([cafe, mine].sort())
      expect(results.places.find((p) => p.placeId === cafe)).toEqual({
        placeId: cafe,
        name: 'Maya Cafe',
        areaName: 'Mission',
        lat: 37.7596,
        lng: -122.427,
        category: 'park',
      })
      for (const as of ['visitor' as const, guest, claiming, stranger.as]) {
        const ids = placeIds(await search(db, 'maya', as))
        expect(ids).toContain(cafe)
        expect(ids).not.toContain(mine)
        expect(ids.includes(secret)).toBe(as === stranger.as)
      }
      const dolores = await placeByKey(db, 'dolores-park')
      expect((await search(db, 'dolores', 'visitor')).places.map((p) => p.placeId)).toEqual([
        dolores,
      ])
      expect((await search(db, 'Dolores Park', me.as)).places[0]?.name).toBe('Dolores Park')
      expect((await search(db, 'Delores', me.as)).places.map((p) => p.placeId)).toEqual([dolores])
    })
  })

  describe('posts', () => {
    const posts: Record<string, string> = {}

    beforeAll(async () => {
      posts['friendFriends'] = (
        await createPost(db, friend, { text: 'lunch with maya', audience: 'friends' })
      ).post.id
      posts['strangerWorld'] = (
        await createPost(db, stranger, { text: 'maya rocks', audience: 'world' })
      ).post.id
      posts['strangerFriends'] = (
        await createPost(db, stranger, { text: 'maya private', audience: 'friends' })
      ).post.id
      posts['blockedWorld'] = (
        await createPost(db, blockedByMe, { text: 'maya from blocked', audience: 'world' })
      ).post.id
      posts['blockerWorld'] = (
        await createPost(db, blocker, { text: 'maya from blocker', audience: 'world' })
      ).post.id
      posts['mine'] = (
        await createPost(db, me, { text: 'my maya note', audience: 'friends' })
      ).post.id
      posts['hiddenByMe'] = (
        await createPost(db, stranger, { text: 'maya hidden post', audience: 'world' })
      ).post.id
      await db.rpc('post_hide', { post_id: posts['hiddenByMe'] }, me.as)
      posts['removed'] = (
        await createPost(db, stranger, { text: 'maya removed post', audience: 'world' })
      ).post.id
      await db.rpc('post_delete', { post_id: posts['removed'] }, stranger.as)
      posts['other'] = (
        await createPost(db, stranger, { text: 'nothing to see', audience: 'world' })
      ).post.id
    })

    it('returns posts visible to the caller whose text matches, not hidden or removed ones', async () => {
      const results = await search(db, 'maya', me.as, 50)
      expect(postIds(results)).toEqual(
        [posts['friendFriends'], posts['strangerWorld'], posts['mine']].sort(),
      )
      const view = results.posts.find((p) => p.post.id === posts['strangerWorld'])
      expect(view).toMatchObject({
        post: {
          id: posts['strangerWorld'],
          text: 'maya rocks',
          audience: 'world',
          authorHumanId: stranger.humanId,
        },
        author: { handle: 'stranger', displayName: 'Someone Else' },
        reactionCount: 0,
        replyCount: 0,
        myReaction: null,
        place: null,
        media: [],
      })
      // Others see their own permission view; the blocked pair see nothing of each other.
      expect(postIds(await search(db, 'maya', stranger.as, 50))).toEqual(
        [
          posts['strangerWorld'],
          posts['strangerFriends'],
          posts['blockedWorld'],
          posts['blockerWorld'],
          posts['hiddenByMe'],
        ].sort(),
      )
      expect(postIds(await search(db, 'maya', blockedByMe.as, 50))).not.toContain(posts['mine'])
      expect(postIds(await search(db, 'maya', blocker.as, 50))).not.toContain(posts['mine'])
      expect(postIds(await search(db, 'rocks', me.as))).toEqual([posts['strangerWorld']])
      expect(postIds(await search(db, 'nothing', me.as))).toEqual([posts['other']])
      // Visitors never get posts, even world ones.
      expect((await search(db, 'maya', 'visitor', 50)).posts).toEqual([])
      expect((await search(db, 'maya', guest, 50)).posts).toEqual([])
    })
  })

  describe('rate limit (spec §83: 60 per minute)', () => {
    it('a Human gets 60 searches per minute', async () => {
      const frank = await human(db, 'Frank')
      for (let i = 0; i < 60; i += 1) await search(db, 'maya', frank.as)
      await db.expectError(db.rpc('search', { q: 'maya', limit: 10 }, frank.as), 'rate_limited')
      // Another Human is not affected.
      expect((await search(db, 'maya', me.as)).people.length).toBeGreaterThan(0)
    })

    it('a Visitor gets the reduced budget, keyed by client address', async () => {
      const from = (ip: string) =>
        db.asRole('visitor', async (client) => {
          await client.query(`select set_config('request.headers', $1, true)`, [
            JSON.stringify({ 'cf-connecting-ip': ip }),
          ])
          await client.query(`select public.search('maya', 10)`)
        })
      for (let i = 0; i < 30; i += 1) await from('203.0.113.9')
      await expect(from('203.0.113.9')).rejects.toMatchObject({ message: 'rate_limited' })
      await from('203.0.113.10')
    })
  })
})
