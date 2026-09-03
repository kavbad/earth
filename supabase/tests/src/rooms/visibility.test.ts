import { RoomDtoSchema, RoomVisibilityChangeDtoSchema, allowedJoinPoliciesFor } from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  addMember,
  befriend,
  block,
  createArea,
  createGroup,
  createGuest,
  getRoom,
  human,
  joinRoom,
  participantId,
  participantStatus,
  roomRow,
  setContext,
  setFlag,
  startGroupRoom,
  startStandaloneRoom,
  type GroupFixture,
  type Human,
} from './fixtures'

interface Candidate {
  roomId: string
  visibility: string
  contextTitle: string | null
  areaName: string | null
  participantCount: number
  participants: Array<{ humanId: string | null; relationToViewer: string | null; mediaState: string }>
}
interface LiveList {
  candidates: Candidate[]
  scope: string
  areaName: string | null
}

async function liveRoomIds(db: TestDb, scope: string, as: Human | 'visitor', areaId: string | null = null) {
  const list = await db.rpc<LiveList>('live_candidates', { scope, area_id: areaId }, as === 'visitor' ? 'visitor' : as.as)
  return list.candidates.map((c) => c.roomId)
}

describe('room visibility, consent and Live discovery (spec §58–§60; ARCHITECTURE §10)', () => {
  let db: TestDb
  let owner: Human
  let member: Human
  let group: GroupFixture

  beforeAll(async () => {
    db = await createTestDb()
    owner = await human(db, 'Owner')
    member = await human(db, 'Member')
    group = await createGroup(db, owner, 'Weekend Crew')
    await addMember(db, group, member)
  })

  afterAll(async () => {
    await db.drop()
  })

  describe('room_set_visibility', () => {
    it('widening with an unconsented camera participant is pending until that participant consents', async () => {
      const started = await startGroupRoom(db, owner, group)
      const roomId = started.room.id
      const joined = await joinRoom(db, roomId, member, 'camera', 'group')
      const memberParticipant = participantId(joined, member.humanId)

      const pending = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, owner.as),
      )
      expect(pending).toEqual({
        applied: false,
        visibility: 'group',
        pendingVisibility: 'friends',
        pendingParticipantIds: [memberParticipant],
      })
      expect(await roomRow(db, roomId)).toMatchObject({ visibility: 'group', pending_visibility: 'friends', join_policy: 'group' })
      expect((await getRoom(db, roomId, member.as)).pendingVisibility).toBe('friends')
      // The moderator's own consent is recorded by opening up.
      expect(await participantStatus(db, roomId, owner.humanId)).toMatchObject({ consent: 'friends' })

      // A consent below the pending level changes nothing.
      const still = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_consent', { room_id: roomId, level: 'group' }, member.as),
      )
      expect(still.applied).toBe(false)
      const applied = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_consent', { room_id: roomId, level: 'friends' }, member.as),
      )
      expect(applied).toEqual({ applied: true, visibility: 'friends', pendingVisibility: null, pendingParticipantIds: [] })
      expect(await roomRow(db, roomId)).toMatchObject({ visibility: 'friends', pending_visibility: null, join_policy: 'friends' })
      await db.rpc('room_end', { room_id: roomId }, owner.as)
    })

    it('the pending participant downgrading to watching (or leaving) applies the widening', async () => {
      const started = await startGroupRoom(db, owner, group)
      const roomId = started.room.id
      await joinRoom(db, roomId, member, 'camera', 'group')
      const pending = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, owner.as),
      )
      expect(pending.applied).toBe(false)
      const applied = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_set_media_state', { room_id: roomId, media_state: 'watching' }, member.as),
      )
      expect(applied).toEqual({ applied: true, visibility: 'friends', pendingVisibility: null, pendingParticipantIds: [] })

      // Leaving works the same way.
      const second = await human(db, 'Leaver')
      await addMember(db, group, second)
      await joinRoom(db, roomId, second, 'camera', 'friends')
      const wider = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'extended' }, owner.as),
      )
      expect(wider.applied).toBe(false)
      await db.rpc('room_leave', { room_id: roomId }, second.as)
      expect(await roomRow(db, roomId)).toMatchObject({ visibility: 'extended', pending_visibility: null })
      await db.rpc('room_end', { room_id: roomId }, owner.as)
    })

    it('narrowing applies immediately, clears any pending widening and drops the area', async () => {
      const started = await startGroupRoom(db, owner, group)
      const roomId = started.room.id
      await joinRoom(db, roomId, member, 'camera', 'group')
      await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, owner.as)
      const narrowed = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'group', join_policy: 'invited_only' }, owner.as),
      )
      expect(narrowed).toEqual({ applied: true, visibility: 'group', pendingVisibility: null, pendingParticipantIds: [] })
      expect(await roomRow(db, roomId)).toMatchObject({ visibility: 'group', pending_visibility: null, join_policy: 'invited_only' })
      await db.expectError(
        db.rpc('room_set_visibility', { room_id: roomId, visibility: 'invited' }, owner.as),
        'visibility_not_allowed',
      )
      await db.expectError(
        db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends', join_policy: 'anyone' }, owner.as),
        'invalid_input',
      )
      await db.expectError(
        db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, member.as),
        'not_a_moderator',
      )
      const guest = await createGuest(db)
      await db.expectError(
        db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, guest.as),
        'guest_not_allowed',
      )
      await db.rpc('room_end', { room_id: roomId }, owner.as)
    })

    it('flags gate widening: FRIENDS_LIVE_EXPANSION_ENABLED, WORLD_LIVE_EXPANSION_ENABLED, PUBLIC_LIVE_ENABLED', async () => {
      const started = await startGroupRoom(db, owner, group)
      const roomId = started.room.id
      await setFlag(db, 'FRIENDS_LIVE_EXPANSION_ENABLED', false)
      await db.expectError(
        db.rpc('room_set_visibility', { room_id: roomId, visibility: 'friends' }, owner.as),
        'feature_disabled',
      )
      await setFlag(db, 'FRIENDS_LIVE_EXPANSION_ENABLED', true)
      await setFlag(db, 'WORLD_LIVE_EXPANSION_ENABLED', false)
      await db.expectError(
        db.rpc('room_set_visibility', { room_id: roomId, visibility: 'world' }, owner.as),
        'feature_disabled',
      )
      await setFlag(db, 'WORLD_LIVE_EXPANSION_ENABLED', true)
      await setFlag(db, 'PUBLIC_LIVE_ENABLED', false)
      await db.expectError(
        db.rpc('room_set_visibility', { room_id: roomId, visibility: 'city' }, owner.as),
        'feature_disabled',
      )
      await setFlag(db, 'PUBLIC_LIVE_ENABLED', true)
      // Narrowing never needs a flag.
      await setFlag(db, 'FRIENDS_LIVE_EXPANSION_ENABLED', false)
      const ok = RoomVisibilityChangeDtoSchema.parse(
        await db.rpc('room_set_visibility', { room_id: roomId, visibility: 'group' }, owner.as),
      )
      expect(ok.applied).toBe(true)
      await setFlag(db, 'FRIENDS_LIVE_EXPANSION_ENABLED', true)
      // Neighborhood / city need an area from the moderator's context.
      await db.expectError(
        db.rpc('room_set_visibility', { room_id: roomId, visibility: 'city' }, owner.as),
        'area_not_found',
      )
      await db.rpc('room_end', { room_id: roomId }, owner.as)
    })

    it('room_set_join_policy accepts exactly allowedJoinPoliciesFor(visibility, contextType)', async () => {
      const started = await startGroupRoom(db, owner, group)
      const roomId = started.room.id
      for (const policy of allowedJoinPoliciesFor('group', 'group')) {
        const room = RoomDtoSchema.parse(await db.rpc('room_set_join_policy', { room_id: roomId, join_policy: policy }, owner.as))
        expect(room.joinPolicy).toBe(policy)
      }
      for (const policy of ['friends', 'anyone', 'anyone_with_link', 'friends_of_friends'] as const) {
        expect(allowedJoinPoliciesFor('group', 'group')).not.toContain(policy)
        await db.expectError(db.rpc('room_set_join_policy', { room_id: roomId, join_policy: policy }, owner.as), 'invalid_input')
      }
      await db.rpc('room_end', { room_id: roomId }, owner.as)

      const solo = await startStandaloneRoom(db, owner)
      // `group` is not offered for rooms without a group.
      expect(allowedJoinPoliciesFor('friends', 'standalone')).not.toContain('group')
      await db.expectError(db.rpc('room_set_join_policy', { room_id: solo.room.id, join_policy: 'group' }, owner.as), 'invalid_input')
      await db.rpc('room_end', { room_id: solo.room.id }, owner.as)
    })
  })

  describe('friends Live cross-pollination (spec §58) and blocks (spec §128)', () => {
    let a: Human
    let b: Human
    let friendOfB: Human
    let watcher: Human
    let friendOfWatcher: Human
    let blockedByB: Human
    let roomId: string

    beforeAll(async () => {
      a = await human(db, 'Alpha')
      b = await human(db, 'Beta')
      friendOfB = await human(db, 'Fob')
      watcher = await human(db, 'Watcher')
      friendOfWatcher = await human(db, 'Fow')
      blockedByB = await human(db, 'Blocked')
      await befriend(db, a, b)
      await befriend(db, b, friendOfB)
      await befriend(db, a, watcher)
      await befriend(db, watcher, friendOfWatcher)
      await befriend(db, a, blockedByB)
      await block(db, b, blockedByB)
      const started = await startStandaloneRoom(db, a, 'Coffee')
      roomId = started.room.id
      await joinRoom(db, roomId, b, 'camera', 'friends')
      await joinRoom(db, roomId, watcher, 'watching')
    })

    afterAll(async () => {
      await db.rpc('room_end', { room_id: roomId }, a.as)
    })

    it('a friend of ANY consenting camera participant sees the room in live_candidates and room_get', async () => {
      expect(await liveRoomIds(db, 'friends', friendOfB)).toEqual([roomId])
      const room = await getRoom(db, roomId, friendOfB.as)
      expect(room.participants.map((p) => [p.humanId, p.relationToViewer])).toEqual([
        [a.humanId, 'other'],
        [b.humanId, 'friend'],
      ])
      // Viewers are never revealed to someone outside the room.
      expect(room.participants.some((p) => p.humanId === watcher.humanId)).toBe(false)
      const list = await db.rpc<LiveList>('live_candidates', { scope: 'friends' }, friendOfB.as)
      expect(list.candidates[0]).toMatchObject({ roomId, visibility: 'friends', contextTitle: null, participantCount: 2 })
      expect(list.candidates[0]?.participants.map((p) => p.relationToViewer)).toEqual(['other', 'friend'])
    })

    it('a friend of a watching-only viewer does not see the room', async () => {
      expect(await liveRoomIds(db, 'friends', friendOfWatcher)).toEqual([])
      await db.expectError(db.rpc('room_get', { room_id: roomId }, friendOfWatcher.as), 'room_not_found')
      // Once the viewer publishes, their friends become eligible (spec §59).
      await db.rpc('room_set_media_state', { room_id: roomId, media_state: 'audio', consent_level: 'friends' }, watcher.as)
      expect(await liveRoomIds(db, 'friends', friendOfWatcher)).toEqual([roomId])
      await db.rpc('room_set_media_state', { room_id: roomId, media_state: 'watching' }, watcher.as)
      expect(await liveRoomIds(db, 'friends', friendOfWatcher)).toEqual([])
    })

    it('a Human blocked by a consenting participant cannot see the room anywhere', async () => {
      expect(await liveRoomIds(db, 'friends', blockedByB)).toEqual([])
      await db.expectError(db.rpc('room_get', { room_id: roomId }, blockedByB.as), 'room_not_found')
      await db.expectError(
        db.rpc('room_join', { room_id: roomId, media_state: 'camera', consent_level: 'friends' }, blockedByB.as),
        'room_not_found',
      )
      const visible = await db.asRole(blockedByB.as, (c) => c.query('select id from public.rooms where id = $1', [roomId]))
      expect(visible.rowCount).toBe(0)
      // Visitors and guests never see a friends room; strangers neither.
      await db.expectError(db.rpc('room_get', { room_id: roomId }, 'visitor'), 'room_not_found')
      const stranger = await human(db, 'Stranger')
      expect(await liveRoomIds(db, 'friends', stranger)).toEqual([])
      const guest = await createGuest(db)
      await db.expectError(db.rpc('live_candidates', { scope: 'friends' }, guest.as), 'guest_not_allowed')
    })
  })

  describe('live_candidates scopes (SCREEN 13; spec §52, §76)', () => {
    let city: string
    let mission: string
    let castro: string
    let otherCity: string
    let host: Human
    let local: Human
    let sameCity: Human
    let elsewhere: Human
    let friend: Human
    let neighborhoodRoom: string
    let cityRoom: string
    let worldRoom: string

    beforeAll(async () => {
      city = await createArea(db, { name: 'San Francisco', slug: 'sf', type: 'city' })
      mission = await createArea(db, { name: 'Mission', slug: 'mission', type: 'neighborhood', parentAreaId: city })
      castro = await createArea(db, { name: 'Castro', slug: 'castro', type: 'neighborhood', parentAreaId: city })
      otherCity = await createArea(db, { name: 'Oakland', slug: 'oakland', type: 'city' })
      host = await human(db, 'Host')
      local = await human(db, 'Local')
      sameCity = await human(db, 'Samecity')
      elsewhere = await human(db, 'Elsewhere')
      friend = await human(db, 'Hostfriend')
      await befriend(db, host, friend)
      await setContext(db, host, { currentAreaId: mission, currentCityId: city })
      await setContext(db, local, { currentAreaId: mission, currentCityId: city })
      await setContext(db, sameCity, { currentAreaId: castro, currentCityId: city })
      await setContext(db, elsewhere, { currentCityId: otherCity })

      const n = await startStandaloneRoom(db, host, 'Block party')
      neighborhoodRoom = n.room.id
      await db.rpc('room_set_visibility', { room_id: neighborhoodRoom, visibility: 'neighborhood' }, host.as)
      const c = await startStandaloneRoom(db, host, 'City walk')
      cityRoom = c.room.id
      await db.rpc('room_set_visibility', { room_id: cityRoom, visibility: 'city' }, host.as)
      const w = await startStandaloneRoom(db, host, 'Hello world')
      worldRoom = w.room.id
      await db.rpc('room_set_visibility', { room_id: worldRoom, visibility: 'world' }, host.as)
    })

    afterAll(async () => {
      for (const id of [neighborhoodRoom, cityRoom, worldRoom]) {
        await db.rpc('room_end', { room_id: id }, host.as)
      }
    })

    it('opening up takes the area from the moderator context: neighborhood precision or city precision', async () => {
      expect(await roomRow(db, neighborhoodRoom)).toMatchObject({ visibility: 'neighborhood', area_id: mission, area_precision: 'neighborhood' })
      expect(await roomRow(db, cityRoom)).toMatchObject({ visibility: 'city', area_id: city, area_precision: 'city' })
      expect(await roomRow(db, worldRoom)).toMatchObject({ visibility: 'world', area_id: city, area_precision: 'city' })
    })

    it('neighborhood scope: rooms in the viewer area (context or explicit area_id)', async () => {
      expect(await liveRoomIds(db, 'neighborhood', local)).toEqual([neighborhoodRoom])
      expect(await liveRoomIds(db, 'neighborhood', sameCity)).toEqual([])
      expect(await liveRoomIds(db, 'neighborhood', sameCity, mission)).toEqual([neighborhoodRoom])
      await db.expectError(db.rpc('live_candidates', { scope: 'neighborhood' }, elsewhere.as), 'area_not_found')
      const list = await db.rpc<LiveList>('live_candidates', { scope: 'neighborhood' }, local.as)
      expect(list).toMatchObject({ scope: 'neighborhood', areaName: 'Mission' })
      expect(list.candidates[0]).toMatchObject({ areaName: 'Mission', participantCount: 1 })
      expect(list.candidates[0]?.participants[0]).toMatchObject({ humanId: host.humanId, relationToViewer: 'other', mediaState: 'camera' })
    })

    it('city scope: city and world Lives located in the city, plus the neighborhood Lives the viewer is eligible for', async () => {
      expect((await liveRoomIds(db, 'city', sameCity)).sort()).toEqual([cityRoom, worldRoom].sort())
      expect((await liveRoomIds(db, 'city', local)).sort()).toEqual([cityRoom, neighborhoodRoom, worldRoom].sort())
      expect(await liveRoomIds(db, 'city', elsewhere)).toEqual([])
      // Browsing another city explicitly is a browsing context (spec §52): its city Lives open up.
      expect((await liveRoomIds(db, 'city', elsewhere, city)).sort()).toEqual([cityRoom, worldRoom].sort())
      expect((await liveRoomIds(db, 'city', elsewhere, otherCity)).sort()).toEqual([])
      await db.expectError(db.rpc('room_get', { room_id: cityRoom }, elsewhere.as), 'room_not_found')
      expect((await getRoom(db, cityRoom, sameCity.as)).visibility).toBe('city')
    })

    it('world scope: world Lives for everyone, visitors only while PUBLIC_LIVE_ENABLED', async () => {
      expect(await liveRoomIds(db, 'world', elsewhere)).toEqual([worldRoom])
      expect(await liveRoomIds(db, 'world', 'visitor')).toEqual([worldRoom])
      const asVisitor = await getRoom(db, worldRoom, 'visitor')
      expect(asVisitor.participants[0]?.relationToViewer).toBeNull()
      expect(asVisitor.myParticipant).toBeNull()
      await db.expectError(db.rpc('live_candidates', { scope: 'friends' }, 'visitor'), 'not_authenticated')
      await setFlag(db, 'PUBLIC_LIVE_ENABLED', false)
      await db.expectError(db.rpc('live_candidates', { scope: 'world' }, 'visitor'), 'feature_disabled')
      await db.expectError(db.rpc('room_get', { room_id: worldRoom }, 'visitor'), 'room_not_found')
      expect(await liveRoomIds(db, 'world', elsewhere)).toEqual([worldRoom])
      await setFlag(db, 'PUBLIC_LIVE_ENABLED', true)
      await setFlag(db, 'WORLD_ENABLED', false)
      await db.expectError(db.rpc('live_candidates', { scope: 'world' }, elsewhere.as), 'feature_disabled')
      await setFlag(db, 'WORLD_ENABLED', true)
    })

    it('friends scope lists every room reached through the social graph, with relationToViewer', async () => {
      const ids = await liveRoomIds(db, 'friends', friend)
      expect(ids.sort()).toEqual([neighborhoodRoom, cityRoom, worldRoom].sort())
      const list = await db.rpc<LiveList>('live_candidates', { scope: 'friends' }, friend.as)
      for (const candidate of list.candidates) {
        expect(candidate.participants[0]?.relationToViewer).toBe('friend')
      }
      expect(await liveRoomIds(db, 'friends', local)).toEqual([])
    })
  })
})
