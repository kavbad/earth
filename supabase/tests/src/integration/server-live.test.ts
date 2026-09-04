/**
 * `GET /api/live` end to end (ARCHITECTURE §6; spec SCREEN 13, §58–§60): `handleLive` runs
 * against the real `live_candidates` through the harness-backed deps and orders the rooms the way
 * Live Home ranks them — rooms with direct friends (closest first) → the viewer's group rooms →
 * socially adjacent → the rest; World by publishers then recency — with participant-aware titles.
 */
import { LiveListDtoSchema } from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  addMember,
  befriend,
  createArea,
  createGroup,
  human,
  joinRoom,
  setContext,
  startGroupRoom,
  startStandaloneRoom,
  type GroupFixture,
  type Human,
} from '../rooms/fixtures'
import {
  createEarthServer,
  createServerTestDeps,
  fakeRequest,
  type EarthServer,
  type ServerTestDeps,
} from './server-deps'

describe('GET /api/live (server tier ↔ live_candidates, SCREEN 13)', () => {
  let db: TestDb
  let ctx: ServerTestDeps
  let server: EarthServer
  let me: Human
  let ada: Human
  let ben: Human
  let cy: Human
  let dee: Human
  let eve: Human
  let group: GroupFixture
  let twoFriendsRoom: string
  let oneFriendRoom: string
  let groupRoom: string
  let friendOfFriendRoom: string

  beforeAll(async () => {
    db = await createTestDb()
    ctx = createServerTestDeps(db)
    server = createEarthServer(ctx.deps)
    const city = await createArea(db, { name: 'San Francisco', slug: 'sf', type: 'city' })
    const mission = await createArea(db, {
      name: 'Mission',
      slug: 'mission',
      type: 'neighborhood',
      parentAreaId: city,
    })
    me = await human(db, 'Me')
    ada = await human(db, 'Ada')
    ben = await human(db, 'Ben')
    cy = await human(db, 'Cy')
    dee = await human(db, 'Dee')
    eve = await human(db, 'Eve')
    for (const friend of [ada, ben, cy]) await befriend(db, me, friend)
    await befriend(db, ada, ben)
    await befriend(db, ada, eve)
    for (const host of [cy, eve])
      await setContext(db, host, { currentAreaId: mission, currentCityId: city })
    group = await createGroup(db, dee, 'Weekend Crew')
    await addMember(db, group, me)

    // Cy alone, opened up to World (a friend's room, one publisher).
    oneFriendRoom = (await startStandaloneRoom(db, cy, 'Late walk')).room.id
    await db.rpc('room_set_visibility', { room_id: oneFriendRoom, visibility: 'world' }, cy.as)
    // Ada + Ben on camera (two friends).
    twoFriendsRoom = (await startStandaloneRoom(db, ada, 'Cooking dinner')).room.id
    await joinRoom(db, twoFriendsRoom, ben, 'camera', 'friends')
    // The viewer's group, hosted by a groupmate who is not a friend.
    groupRoom = (await startGroupRoom(db, dee, group)).room.id
    // Eve is a friend of Ada only: reachable as a friend of a friend once opened up to World.
    friendOfFriendRoom = (await startStandaloneRoom(db, eve, 'Open mic')).room.id
    await db.rpc(
      'room_set_visibility',
      { room_id: friendOfFriendRoom, visibility: 'world' },
      eve.as,
    )
    ctx.clock.now = new Date(Date.now() + 1_000)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('friends scope: rooms with friends (closest first), then the group room, then the rest', async () => {
    const bearer = ctx.tokens.for(me.as)
    const res = await server.handle(fakeRequest({ url: '/api/live?scope=friends', bearer }))
    expect(res.status).toBe(200)
    const list = LiveListDtoSchema.parse(res.body)
    expect(list).toMatchObject({ scope: 'friends', areaName: null })
    expect(list.cards.map((card) => card.roomId)).toEqual([
      twoFriendsRoom,
      oneFriendRoom,
      groupRoom,
      friendOfFriendRoom,
    ])
    expect(list.cards.map((card) => card.title)).toEqual([
      'Ada + Ben are live',
      'Cy is live',
      'Weekend Crew is live',
      'Eve is live',
    ])
    expect(list.cards[0]).toMatchObject({
      id: twoFriendsRoom,
      participantNames: ['Ada', 'Ben'],
      participantAvatars: [null, null],
      participantCount: 2,
      visibility: 'friends',
      contextTitle: null,
    })
    expect(list.cards[2]).toMatchObject({
      contextTitle: 'Weekend Crew',
      participantNames: ['Dee'],
      visibility: 'group',
    })
    expect(list.cards[3]).toMatchObject({ participantNames: ['Eve'], visibility: 'world' })
    expect(ctx.callsTo('live_candidates').at(-1)).toMatchObject({
      client: `user:${bearer}`,
      as: me.as,
      args: { scope: 'friends', area_id: null },
    })
  })

  it('world scope: public Lives by publisher count then recency; Visitors need no bearer', async () => {
    const asVisitor = await server.handle(fakeRequest({ url: '/api/live?scope=world' }))
    expect(asVisitor.status).toBe(200)
    const visitorList = LiveListDtoSchema.parse(asVisitor.body)
    // Both have one publisher; Eve's room started later.
    expect(visitorList.cards.map((card) => card.roomId)).toEqual([
      friendOfFriendRoom,
      oneFriendRoom,
    ])
    expect(visitorList.cards.map((card) => card.title)).toEqual(['Eve is live', 'Cy is live'])
    expect(ctx.callsTo('live_candidates').at(-1)).toMatchObject({ client: 'anon', as: 'visitor' })

    const asHuman = await server.handle(
      fakeRequest({ url: '/api/live?scope=world', bearer: ctx.tokens.for(me.as) }),
    )
    expect(LiveListDtoSchema.parse(asHuman.body).cards.map((card) => card.roomId)).toEqual([
      friendOfFriendRoom,
      oneFriendRoom,
    ])
  })

  it('any scope but World needs a bearer', async () => {
    for (const scope of ['friends', 'neighborhood', 'city']) {
      const res = await server.handle(fakeRequest({ url: `/api/live?scope=${scope}` }))
      expect(res.status).toBe(401)
      expect(res.body).toMatchObject({ error: { code: 'not_authenticated' } })
    }
  })
})
