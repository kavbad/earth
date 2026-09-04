/**
 * map_objects (SCREEN 20; DB_API §5; spec §52, §74, §76, §128 "Exact location is never inferred as
 * public permission"): the four map layers per scope and bounding box. Lives are pinned at their
 * Place or their area's centroid only — never at a participant's device position; friend shares are
 * the explicit, precision-degraded shares of `location_shares_visible`; moments are visible posts
 * tagged with a Place; blocks remove all three; visitors get the public World only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  BASE_AREA_SLUGS,
  DOLORES_PARK,
  MISSION_BBOX,
  MISSION_CENTROID,
  NORTH_BEACH_BBOX,
  OCEAN_BBOX,
  POINTS,
  SF_BBOX,
  SF_CENTROID,
  WASHINGTON_SQUARE,
  areaBySlug,
  bboxArgs,
  befriend,
  block,
  createGuest,
  createHuman,
  createPost,
  createPrivatePlace,
  createShare,
  createUnclaimed,
  endRoom,
  expectedPosition,
  human,
  mapObjects,
  openUp,
  placeByKey,
  roomRow,
  setContext,
  setFlag,
  setHuman,
  setPlaceFixture,
  setRoomPlace,
  setSetting,
  startStandaloneRoom,
  type Human,
} from './fixtures'

const SCOPES = ['friends', 'neighborhood', 'city', 'world'] as const

describe('map_objects (SCREEN 20)', () => {
  let db: TestDb
  let sf: string
  let mission: string
  let doloresPark: string
  let washingtonSquare: string
  let alice: Human
  let bob: Human
  let carol: Human
  let dave: Human
  let guest: RoleSpec
  let claiming: RoleSpec
  let unclaimed: RoleSpec

  const posts: Record<string, string> = {}
  const roomIds = (objects: { lives: Array<{ roomId: string }> }) =>
    objects.lives.map((l) => l.roomId)
  const momentIds = (objects: { moments: Array<{ postId: string }> }) =>
    objects.moments.map((m) => m.postId).sort()
  const friendIds = (objects: { friends: Array<{ humanId: string }> }) =>
    objects.friends.map((f) => f.humanId)

  beforeAll(async () => {
    db = await createTestDb()
    sf = await areaBySlug(db, BASE_AREA_SLUGS.sanFrancisco)
    mission = await areaBySlug(db, BASE_AREA_SLUGS.mission)
    doloresPark = await placeByKey(db, 'dolores-park')
    washingtonSquare = await placeByKey(db, 'washington-square-park')
    alice = await human(db, 'Alice')
    bob = await human(db, 'Bob')
    carol = await human(db, 'Carol')
    dave = await human(db, 'Dave')
    await befriend(db, alice, bob)
    await befriend(db, alice, dave)
    await setContext(db, alice, { currentAreaId: mission, currentCityId: sf, homeCityId: sf })
    await setContext(db, bob, { currentAreaId: mission, currentCityId: sf, homeCityId: sf })
    await setContext(db, carol, { currentCityId: sf, homeCityId: sf })
    await setContext(db, dave, { currentCityId: sf })
    guest = (await createGuest(db)).as
    claiming = (await createHuman(db, { handle: 'claiming', status: 'pending' })).as
    unclaimed = (await createUnclaimed(db)).as
  })

  afterAll(async () => {
    await db.drop()
  })

  describe('callers and arguments', () => {
    it('visitors, claiming and unclaimed credentials get World only; Guests have no map', async () => {
      for (const scope of ['friends', 'neighborhood', 'city'] as const) {
        await db.expectError(
          db.rpc('map_objects', bboxArgs(scope, SF_BBOX), 'visitor'),
          'not_authenticated',
        )
        await db.expectError(
          db.rpc('map_objects', bboxArgs(scope, SF_BBOX), claiming),
          'not_authenticated',
        )
        await db.expectError(
          db.rpc('map_objects', bboxArgs(scope, SF_BBOX), unclaimed),
          'not_authenticated',
        )
      }
      for (const scope of SCOPES) {
        await db.expectError(
          db.rpc('map_objects', bboxArgs(scope, SF_BBOX), guest),
          'guest_not_allowed',
        )
      }
      for (const as of ['visitor' as const, claiming, unclaimed]) {
        const objects = await mapObjects(db, 'world', SF_BBOX, as)
        expect(objects.friends).toEqual([])
        expect(objects.places.map((p) => p.name)).toContain('Dolores Park')
      }
      // The service reads as an anonymous viewer too (no Human behind it).
      expect((await mapObjects(db, 'world', SF_BBOX, 'service')).friends).toEqual([])
      for (const scope of SCOPES) {
        const objects = await mapObjects(db, scope, SF_BBOX, alice.as)
        expect(objects).toEqual({
          lives: expect.any(Array),
          places: expect.any(Array),
          friends: [],
          moments: [],
        })
      }
    })

    it('validates the scope and the box', async () => {
      await db.expectError(
        db.rpc('map_objects', { ...bboxArgs('world', SF_BBOX), scope: null }, alice.as),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'map_objects',
          { scope: 'world', min_lat: 37.9, min_lng: -122.6, max_lat: 37.6, max_lng: -122.2 },
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'map_objects',
          { scope: 'world', min_lat: 37.6, min_lng: -122.2, max_lat: 37.9, max_lng: -122.6 },
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'map_objects',
          { scope: 'world', min_lat: 37.6, min_lng: -122.6, max_lat: 91, max_lng: -122.2 },
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'map_objects',
          { scope: 'world', min_lat: null, min_lng: -122.6, max_lat: 37.9, max_lng: -122.2 },
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'map_objects',
          { scope: 'world', min_lat: -90, min_lng: -181, max_lat: 90, max_lng: 180 },
          'visitor',
        ),
        'invalid_input',
      )
      // The whole world is a valid box.
      expect(
        (
          await mapObjects(
            db,
            'world',
            { minLat: -90, minLng: -180, maxLat: 90, maxLng: 180 },
            'visitor',
          )
        ).places.length,
      ).toBeGreaterThan(0)
    })

    it('honours the scope flags', async () => {
      await setFlag(db, 'CITY_ENABLED', false)
      await db.expectError(
        db.rpc('map_objects', bboxArgs('city', SF_BBOX), alice.as),
        'feature_disabled',
      )
      await setFlag(db, 'CITY_ENABLED', true)
      await setFlag(db, 'NEIGHBORHOOD_ENABLED', false)
      await db.expectError(
        db.rpc('map_objects', bboxArgs('neighborhood', SF_BBOX), alice.as),
        'feature_disabled',
      )
      await setFlag(db, 'NEIGHBORHOOD_ENABLED', true)
      await setFlag(db, 'WORLD_ENABLED', false)
      await db.expectError(
        db.rpc('map_objects', bboxArgs('world', SF_BBOX), alice.as),
        'feature_disabled',
      )
      // Visitors depend on the public flags, not WORLD_ENABLED.
      expect((await mapObjects(db, 'world', SF_BBOX, 'visitor')).friends).toEqual([])
      await setFlag(db, 'WORLD_ENABLED', true)
      await setFlag(db, 'PUBLIC_LIVE_ENABLED', false)
      await setFlag(db, 'PUBLIC_WORLD_ENABLED', false)
      await db.expectError(
        db.rpc('map_objects', bboxArgs('world', SF_BBOX), 'visitor'),
        'feature_disabled',
      )
      expect((await mapObjects(db, 'world', SF_BBOX, alice.as)).friends).toEqual([])
      await setFlag(db, 'PUBLIC_LIVE_ENABLED', true)
      await setFlag(db, 'PUBLIC_WORLD_ENABLED', true)
    })

    it('neighborhood / city take the area from the context, else from the centre of the box', async () => {
      const nowhere = await human(db, 'Nowhere')
      // No context: the centre of the whole-city box is inside San Francisco but in no neighborhood.
      expect((await mapObjects(db, 'city', SF_BBOX, nowhere.as)).lives).toEqual([])
      await db.expectError(
        db.rpc('map_objects', bboxArgs('neighborhood', SF_BBOX), nowhere.as),
        'area_not_found',
      )
      expect((await mapObjects(db, 'neighborhood', MISSION_BBOX, nowhere.as)).lives).toEqual([])
      await db.expectError(
        db.rpc('map_objects', bboxArgs('city', OCEAN_BBOX), nowhere.as),
        'area_not_found',
      )
      await db.expectError(
        db.rpc('map_objects', bboxArgs('neighborhood', OCEAN_BBOX), nowhere.as),
        'area_not_found',
      )
      // With a context the box does not matter for the area.
      expect((await mapObjects(db, 'city', OCEAN_BBOX, alice.as)).lives).toEqual([])
      expect((await mapObjects(db, 'neighborhood', OCEAN_BBOX, alice.as)).lives).toEqual([])
    })
  })

  describe('lives', () => {
    it('a Live is pinned at its area centroid, never at a participant device position', async () => {
      const started = await startStandaloneRoom(db, alice, 'Cooking dinner')
      const roomId = started.room.id
      await openUp(db, roomId, alice, 'city')
      expect(await roomRow(db, roomId)).toMatchObject({
        visibility: 'city',
        area_id: sf,
        area_precision: 'city',
      })
      // Alice's device is in North Beach and she shares it precisely with Bob.
      const share = await createShare(db, alice, {
        audienceId: bob.humanId,
        precision: 'precise',
        position: POINTS.northBeach,
      })

      const objects = await mapObjects(db, 'friends', SF_BBOX, bob.as)
      const live = objects.lives.find((l) => l.roomId === roomId)
      expect(live).toEqual({
        roomId,
        title: 'Alice is live',
        lat: SF_CENTROID.lat,
        lng: SF_CENTROID.lng,
        precision: 'city',
        participantCount: 1,
      })
      const friend = objects.friends.find((f) => f.humanId === alice.humanId)
      expect(friend).toMatchObject({
        displayName: 'Alice',
        avatarUrl: null,
        lat: POINTS.northBeach.lat,
        lng: POINTS.northBeach.lng,
        precision: 'precise',
        expiresAt: share.expiresAt,
      })
      expect([live?.lat, live?.lng]).not.toEqual([friend?.lat, friend?.lng])
      // Outside the explicit share nothing on the map carries the device coordinates.
      const withoutShares = JSON.stringify({ ...objects, friends: [] })
      expect(withoutShares).not.toContain('37.80123')
      expect(withoutShares).not.toContain('122.41234')
      // The box around North Beach (where the device is) shows the share but not the Live.
      const northBeach = await mapObjects(db, 'friends', NORTH_BEACH_BBOX, bob.as)
      expect(roomIds(northBeach)).not.toContain(roomId)
      expect(friendIds(northBeach)).toEqual([alice.humanId])

      // Discovery is the rooms tier's: the initiator, friends, and anyone in the city (city scope).
      expect(roomIds(await mapObjects(db, 'friends', SF_BBOX, alice.as))).toContain(roomId)
      expect(roomIds(await mapObjects(db, 'city', SF_BBOX, bob.as))).toContain(roomId)
      expect(roomIds(await mapObjects(db, 'city', SF_BBOX, carol.as))).toContain(roomId)
      expect(roomIds(await mapObjects(db, 'friends', SF_BBOX, carol.as))).not.toContain(roomId)
      expect(roomIds(await mapObjects(db, 'world', SF_BBOX, carol.as))).not.toContain(roomId)
      expect(roomIds(await mapObjects(db, 'world', SF_BBOX, 'visitor'))).not.toContain(roomId)
      const strangerView = (await mapObjects(db, 'city', SF_BBOX, carol.as)).lives.find(
        (l) => l.roomId === roomId,
      )
      expect(strangerView).toMatchObject({
        title: 'Alice is live',
        lat: SF_CENTROID.lat,
        lng: SF_CENTROID.lng,
        precision: 'city',
      })

      // An explicitly attached public Place moves the pin to the Place (spec §76).
      await setRoomPlace(db, roomId, doloresPark)
      const pinned = (await mapObjects(db, 'friends', SF_BBOX, bob.as)).lives.find(
        (l) => l.roomId === roomId,
      )
      expect(pinned).toMatchObject({
        lat: DOLORES_PARK.lat,
        lng: DOLORES_PARK.lng,
        precision: 'place',
      })
      expect(roomIds(await mapObjects(db, 'friends', MISSION_BBOX, bob.as))).toContain(roomId)

      await db.rpc('location_share_revoke', { share_id: share.id }, alice.as)
      await endRoom(db, roomId, alice)
      expect(roomIds(await mapObjects(db, 'friends', SF_BBOX, bob.as))).not.toContain(roomId)
    })

    it('neighborhood precision pins at the neighborhood centroid; the box centre stands in for a missing context', async () => {
      const started = await startStandaloneRoom(db, bob)
      const roomId = started.room.id
      await openUp(db, roomId, bob, 'neighborhood')
      expect(await roomRow(db, roomId)).toMatchObject({
        area_id: mission,
        area_precision: 'neighborhood',
      })
      const live = (await mapObjects(db, 'neighborhood', SF_BBOX, alice.as)).lives.find(
        (l) => l.roomId === roomId,
      )
      expect(live).toEqual({
        roomId,
        title: 'Bob is live',
        lat: MISSION_CENTROID.lat,
        lng: MISSION_CENTROID.lng,
        precision: 'neighborhood',
        participantCount: 1,
      })
      expect(roomIds(await mapObjects(db, 'friends', SF_BBOX, alice.as))).toContain(roomId)
      expect(roomIds(await mapObjects(db, 'city', SF_BBOX, alice.as))).toContain(roomId)
      expect(
        roomIds(await mapObjects(db, 'neighborhood', NORTH_BEACH_BBOX, alice.as)),
      ).not.toContain(roomId)
      // Carol has a city but no neighborhood context: browsing the Mission on the map is her area.
      expect(roomIds(await mapObjects(db, 'neighborhood', MISSION_BBOX, carol.as))).toContain(
        roomId,
      )
      await db.expectError(
        db.rpc('map_objects', bboxArgs('neighborhood', SF_BBOX), carol.as),
        'area_not_found',
      )
      await endRoom(db, roomId, bob)
    })

    it('rooms without an area precision (and without a Place) are not on the map', async () => {
      const started = await startStandaloneRoom(db, bob)
      const roomId = started.room.id
      expect(await roomRow(db, roomId)).toMatchObject({
        visibility: 'friends',
        area_precision: 'none',
        area_id: null,
      })
      const discovered = await db.rpc<{ candidates: Array<{ roomId: string }> }>(
        'live_candidates',
        { scope: 'friends' },
        alice.as,
      )
      expect(discovered.candidates.map((c) => c.roomId)).toContain(roomId)
      for (const scope of SCOPES) {
        expect(roomIds(await mapObjects(db, scope, SF_BBOX, alice.as))).not.toContain(roomId)
      }
      expect(roomIds(await mapObjects(db, 'friends', SF_BBOX, bob.as))).not.toContain(roomId)
      // Attaching a Place gives it a position without widening anything.
      await setRoomPlace(db, roomId, washingtonSquare)
      const pinned = (await mapObjects(db, 'friends', SF_BBOX, alice.as)).lives.find(
        (l) => l.roomId === roomId,
      )
      expect(pinned).toMatchObject({
        lat: WASHINGTON_SQUARE.lat,
        lng: WASHINGTON_SQUARE.lng,
        precision: 'place',
      })
      expect(roomIds(await mapObjects(db, 'friends', SF_BBOX, carol.as))).not.toContain(roomId)
      // A Place that no longer resolves leaves the room without a position again.
      await setRoomPlace(db, roomId, null)
      expect(roomIds(await mapObjects(db, 'friends', SF_BBOX, alice.as))).not.toContain(roomId)
      await endRoom(db, roomId, bob)
    })

    it('a Place room is pinned at its Place for its participants', async () => {
      const started = await db.rpc<{
        room: { id: string; placeId: string | null; areaPrecision: string }
      }>('room_start', { context_type: 'place', context_id: doloresPark, title: null }, bob.as)
      const roomId = started.room.id
      expect(started.room).toMatchObject({ placeId: doloresPark, areaPrecision: 'place' })
      const live = (await mapObjects(db, 'friends', SF_BBOX, bob.as)).lives.find(
        (l) => l.roomId === roomId,
      )
      expect(live).toEqual({
        roomId,
        title: 'Bob is live',
        lat: DOLORES_PARK.lat,
        lng: DOLORES_PARK.lng,
        precision: 'place',
        participantCount: 1,
      })
      // Invited-only: a friend who is not a participant does not see it.
      expect(roomIds(await mapObjects(db, 'friends', SF_BBOX, alice.as))).not.toContain(roomId)
      await endRoom(db, roomId, bob)
    })
  })

  describe('friends (location shares)', () => {
    it('share positions degrade by precision and are filtered by the box, in every scope', async () => {
      for (const precision of ['precise', 'approximate', 'city'] as const) {
        const share = await createShare(db, alice, {
          audienceId: bob.humanId,
          precision,
          position: POINTS.northBeach,
        })
        const expected = expectedPosition(precision, POINTS.northBeach, SF_CENTROID)
        for (const scope of SCOPES) {
          const objects = await mapObjects(db, scope, SF_BBOX, bob.as)
          expect(objects.friends).toEqual([
            {
              humanId: alice.humanId,
              displayName: 'Alice',
              avatarUrl: null,
              lat: expected.lat,
              lng: expected.lng,
              precision,
              expiresAt: share.expiresAt,
            },
          ])
        }
        expect(friendIds(await mapObjects(db, 'friends', MISSION_BBOX, bob.as))).toEqual([])
        expect(friendIds(await mapObjects(db, 'friends', NORTH_BEACH_BBOX, bob.as))).toEqual(
          precision === 'city' ? [] : [alice.humanId],
        )
        // The sharer does not see their own share; a non-recipient never does.
        expect(friendIds(await mapObjects(db, 'friends', SF_BBOX, alice.as))).toEqual([])
        expect(friendIds(await mapObjects(db, 'friends', SF_BBOX, carol.as))).toEqual([])
        expect(friendIds(await mapObjects(db, 'friends', SF_BBOX, dave.as))).toEqual([])
        await db.rpc('location_share_revoke', { share_id: share.id }, alice.as)
        expect(friendIds(await mapObjects(db, 'friends', SF_BBOX, bob.as))).toEqual([])
      }
    })
  })

  describe('moments and places', () => {
    beforeAll(async () => {
      posts['aliceFriends'] = (
        await createPost(db, alice, { text: 'brunch', audience: 'friends', placeId: doloresPark })
      ).post.id
      posts['bobWorld'] = (
        await createPost(db, bob, { text: 'sunny', audience: 'world', placeId: doloresPark })
      ).post.id
      posts['carolWorld'] = (
        await createPost(db, carol, { text: 'pizza', audience: 'world', placeId: washingtonSquare })
      ).post.id
      posts['carolCity'] = (
        await createPost(db, carol, {
          text: 'city day',
          audience: 'city',
          areaId: sf,
          placeId: doloresPark,
        })
      ).post.id
      posts['daveFriends'] = (
        await createPost(db, dave, { text: 'coffee', audience: 'friends', placeId: doloresPark })
      ).post.id
      posts['bobNoPlace'] = (
        await createPost(db, bob, { text: 'no place', audience: 'world' })
      ).post.id
    })

    const ids = (keys: string[]) => keys.map((k) => posts[k] ?? '').sort()

    it('friends scope: my own, my friends and followed authors; other scopes: the area pools; world: world posts', async () => {
      const friends = await mapObjects(db, 'friends', SF_BBOX, alice.as)
      expect(momentIds(friends)).toEqual(ids(['aliceFriends', 'bobWorld', 'daveFriends']))
      expect(friends.moments.find((m) => m.postId === posts['bobWorld'])).toEqual({
        postId: posts['bobWorld'],
        lat: DOLORES_PARK.lat,
        lng: DOLORES_PARK.lng,
        authorDisplayName: 'Bob',
      })
      // Neighborhood (Alice is in the Mission): world posts at Mission Places; city-wide posts are not local.
      expect(momentIds(await mapObjects(db, 'neighborhood', SF_BBOX, alice.as))).toEqual(
        ids(['bobWorld']),
      )
      expect(momentIds(await mapObjects(db, 'city', SF_BBOX, alice.as))).toEqual(
        ids(['bobWorld', 'carolWorld', 'carolCity']),
      )
      expect(momentIds(await mapObjects(db, 'world', SF_BBOX, alice.as))).toEqual(
        ids(['bobWorld', 'carolWorld']),
      )
      // A stranger's friends scope has none of these; their world scope the world posts.
      expect(momentIds(await mapObjects(db, 'friends', SF_BBOX, carol.as))).toEqual(
        ids(['carolWorld', 'carolCity']),
      )
      expect(momentIds(await mapObjects(db, 'world', SF_BBOX, carol.as))).toEqual(
        ids(['bobWorld', 'carolWorld']),
      )
      // The box filters by the Place position.
      expect(momentIds(await mapObjects(db, 'world', NORTH_BEACH_BBOX, alice.as))).toEqual(
        ids(['carolWorld']),
      )
      expect(momentIds(await mapObjects(db, 'friends', MISSION_BBOX, alice.as))).toEqual(
        ids(['aliceFriends', 'bobWorld', 'daveFriends']),
      )
      expect(momentIds(await mapObjects(db, 'world', OCEAN_BBOX, alice.as))).toEqual([])
    })

    it('a hidden or removed post leaves the map', async () => {
      await db.rpc('post_hide', { post_id: posts['carolWorld'] }, alice.as)
      expect(momentIds(await mapObjects(db, 'world', SF_BBOX, alice.as))).toEqual(ids(['bobWorld']))
      expect(momentIds(await mapObjects(db, 'world', SF_BBOX, carol.as))).toEqual(
        ids(['bobWorld', 'carolWorld']),
      )
      const gone = (
        await createPost(db, bob, { text: 'bye', audience: 'world', placeId: washingtonSquare })
      ).post.id
      expect(momentIds(await mapObjects(db, 'world', NORTH_BEACH_BBOX, bob.as))).toEqual(
        [gone, posts['carolWorld']].sort(),
      )
      await db.rpc('post_delete', { post_id: gone }, bob.as)
      expect(momentIds(await mapObjects(db, 'world', NORTH_BEACH_BBOX, bob.as))).toEqual(
        ids(['carolWorld']),
      )
    })

    it('places are the public Places inside the box', async () => {
      const objects = await mapObjects(db, 'world', SF_BBOX, alice.as)
      expect(objects.places.map((p) => p.name)).toEqual([
        'Dolores Park',
        'Ferry Building',
        'Washington Square Park',
      ])
      expect(objects.places.find((p) => p.id === doloresPark)).toEqual({
        id: doloresPark,
        name: 'Dolores Park',
        areaId: mission,
        areaName: 'Mission',
        lat: DOLORES_PARK.lat,
        lng: DOLORES_PARK.lng,
        category: 'park',
        visibility: 'public',
      })
      expect(
        (await mapObjects(db, 'world', MISSION_BBOX, alice.as)).places.map((p) => p.name),
      ).toEqual(['Dolores Park'])
      expect((await mapObjects(db, 'world', OCEAN_BBOX, alice.as)).places).toEqual([])
      const secret = await createPrivatePlace(db, alice, mission, 'Secret Spot')
      expect(
        (await mapObjects(db, 'world', SF_BBOX, alice.as)).places.map((p) => p.id),
      ).not.toContain(secret)
      expect(
        (await mapObjects(db, 'world', SF_BBOX, 'visitor')).places.map((p) => p.id),
      ).not.toContain(secret)
    })
  })

  describe('blocks override all discovery (spec §128)', () => {
    it("a blocked friend's share, moment and Live are absent, whoever blocked", async () => {
      const share = await createShare(db, dave, {
        audienceId: alice.humanId,
        precision: 'precise',
        position: POINTS.northBeach,
      })
      const post = (
        await createPost(db, dave, { text: 'dave world', audience: 'world', placeId: doloresPark })
      ).post.id
      const started = await startStandaloneRoom(db, dave)
      const roomId = started.room.id
      await openUp(db, roomId, dave, 'world')
      expect(await roomRow(db, roomId)).toMatchObject({
        visibility: 'world',
        area_id: sf,
        area_precision: 'city',
      })

      for (const scope of ['friends', 'world'] as const) {
        const before = await mapObjects(db, scope, SF_BBOX, alice.as)
        expect(friendIds(before)).toEqual([dave.humanId])
        expect(momentIds(before)).toContain(post)
        expect(roomIds(before)).toContain(roomId)
      }
      await block(db, alice, dave)
      for (const scope of SCOPES) {
        const after = await mapObjects(db, scope, SF_BBOX, alice.as)
        expect(friendIds(after)).toEqual([])
        expect(momentIds(after)).not.toContain(post)
        expect(roomIds(after)).not.toContain(roomId)
      }
      // Others still see the public Live and moment.
      expect(roomIds(await mapObjects(db, 'world', SF_BBOX, carol.as))).toContain(roomId)
      expect(momentIds(await mapObjects(db, 'world', SF_BBOX, carol.as))).toContain(post)

      // The other direction: Carol blocks Bob; Bob no longer sees Carol's public Live or moment.
      const carolRoom = (await startStandaloneRoom(db, carol)).room.id
      await openUp(db, carolRoom, carol, 'world')
      const carolPost = (
        await createPost(db, carol, {
          text: 'carol world',
          audience: 'world',
          placeId: doloresPark,
        })
      ).post.id
      expect(roomIds(await mapObjects(db, 'world', SF_BBOX, bob.as))).toContain(carolRoom)
      expect(momentIds(await mapObjects(db, 'world', SF_BBOX, bob.as))).toContain(carolPost)
      await block(db, carol, bob)
      expect(roomIds(await mapObjects(db, 'world', SF_BBOX, bob.as))).not.toContain(carolRoom)
      expect(momentIds(await mapObjects(db, 'world', SF_BBOX, bob.as))).not.toContain(carolPost)

      await db.rpc('location_share_revoke', { share_id: share.id }, dave.as)
      await endRoom(db, roomId, dave)
      await endRoom(db, carolRoom, carol)
    })
  })

  describe('visitors (SCREEN 01 / spec §43)', () => {
    let wendy: Human
    let worldRoom: string
    let worldPost: string

    beforeAll(async () => {
      wendy = await human(db, 'Wendy')
      await setContext(db, wendy, { currentCityId: sf })
      worldRoom = (await startStandaloneRoom(db, wendy)).room.id
      await openUp(db, worldRoom, wendy, 'world')
      worldPost = (
        await createPost(db, wendy, {
          text: 'hello world',
          audience: 'world',
          placeId: doloresPark,
        })
      ).post.id
      const cityRoom = (await startStandaloneRoom(db, alice)).room.id
      await openUp(db, cityRoom, alice, 'city')
    })

    it('the World map shows public Lives at area precision, public Places and world moments, no friends', async () => {
      const objects = await mapObjects(db, 'world', SF_BBOX, 'visitor')
      expect(objects.lives).toEqual([
        {
          roomId: worldRoom,
          title: 'Wendy is live',
          lat: SF_CENTROID.lat,
          lng: SF_CENTROID.lng,
          precision: 'city',
          participantCount: 1,
        },
      ])
      expect(objects.friends).toEqual([])
      expect(objects.places.map((p) => p.name)).toEqual([
        'Dolores Park',
        'Ferry Building',
        'Washington Square Park',
      ])
      expect(momentIds(objects)).toContain(worldPost)
      expect(objects.moments.every((m) => m.postId !== posts['aliceFriends'])).toBe(true)
      // Same for a Guest? No: Guests have no map. Same for a claiming Human: yes.
      expect(roomIds(await mapObjects(db, 'world', SF_BBOX, claiming))).toEqual([worldRoom])
    })

    it('PUBLIC_LIVE_ENABLED and PUBLIC_WORLD_ENABLED gate the public layers separately', async () => {
      await setFlag(db, 'PUBLIC_LIVE_ENABLED', false)
      const noLives = await mapObjects(db, 'world', SF_BBOX, 'visitor')
      expect(noLives.lives).toEqual([])
      expect(momentIds(noLives)).toContain(worldPost)
      await setFlag(db, 'PUBLIC_LIVE_ENABLED', true)
      await setFlag(db, 'PUBLIC_WORLD_ENABLED', false)
      const noMoments = await mapObjects(db, 'world', SF_BBOX, 'visitor')
      expect(noMoments.moments).toEqual([])
      expect(roomIds(noMoments)).toEqual([worldRoom])
      await setFlag(db, 'PUBLIC_WORLD_ENABLED', true)
      // Humans are unaffected by the public flags.
      await setFlag(db, 'PUBLIC_LIVE_ENABLED', false)
      await setFlag(db, 'PUBLIC_WORLD_ENABLED', false)
      const asHuman = await mapObjects(db, 'world', SF_BBOX, carol.as)
      expect(roomIds(asHuman)).toContain(worldRoom)
      expect(momentIds(asHuman)).toContain(worldPost)
      await setFlag(db, 'PUBLIC_LIVE_ENABLED', true)
      await setFlag(db, 'PUBLIC_WORLD_ENABLED', true)
    })

    it('development fixtures never reach the map in production', async () => {
      await setHuman(db, wendy, { isFixture: true })
      await setPlaceFixture(db, washingtonSquare, true)
      await setSetting(db, 'environment', 'production')
      for (const as of ['visitor' as const, carol.as]) {
        const objects = await mapObjects(db, 'world', SF_BBOX, as)
        expect(roomIds(objects)).not.toContain(worldRoom)
        expect(momentIds(objects)).not.toContain(worldPost)
        expect(objects.places.map((p) => p.id)).not.toContain(washingtonSquare)
      }
      await setSetting(db, 'environment', 'development')
      expect(roomIds(await mapObjects(db, 'world', SF_BBOX, 'visitor'))).toEqual([worldRoom])
      expect((await mapObjects(db, 'world', SF_BBOX, 'visitor')).places.map((p) => p.id)).toContain(
        washingtonSquare,
      )
      await setHuman(db, wendy, { isFixture: false })
      await setPlaceFixture(db, washingtonSquare, false)
    })
  })
})
