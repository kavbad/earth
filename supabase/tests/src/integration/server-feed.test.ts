/**
 * `GET /api/feed` end to end (ARCHITECTURE §6, §9; spec PART IX): `handleFeed` runs against the
 * real `feed_candidates` through the harness-backed deps. Page 1 carries the caller's friend posts
 * and viewer-named Live cards, page 2 follows the keyset cursor with no repeats and no Lives, a
 * Visitor reads World without a bearer, and every other scope needs one.
 */
import {
  FEED_PAGE_SIZE,
  FeedPageDtoSchema,
  type FeedCardDto,
  type LiveCardDto,
} from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  addMember,
  befriend,
  createGroup,
  createPost,
  human,
  joinRoom,
  startGroupRoom,
  startStandaloneRoom,
  type GroupFixture,
  type Human,
} from '../posts/fixtures'
import {
  createEarthServer,
  createServerTestDeps,
  fakeRequest,
  type EarthServer,
  type ServerTestDeps,
} from './server-deps'

const isLive = (card: FeedCardDto): card is LiveCardDto => card.kind === 'live'

describe('GET /api/feed (server tier ↔ feed_candidates)', () => {
  let db: TestDb
  let ctx: ServerTestDeps
  let server: EarthServer
  let me: Human
  let xavier: Human
  let kavon: Human
  let maya: Human
  let groupmate: Human
  let stranger: Human
  let group: GroupFixture
  let duoRoom: string
  let groupRoom: string
  let worldPostByXavier: string
  let worldPostByStranger: string
  let friendsPostByStranger: string
  const friendPosts = new Set<string>()

  beforeAll(async () => {
    db = await createTestDb()
    ctx = createServerTestDeps(db)
    server = createEarthServer(ctx.deps)
    me = await human(db, 'Me')
    xavier = await human(db, 'Xavier')
    kavon = await human(db, 'Kavon')
    maya = await human(db, 'Maya')
    groupmate = await human(db, 'Groupmate')
    stranger = await human(db, 'Stranger')
    await befriend(db, me, xavier)
    await befriend(db, me, kavon)
    await befriend(db, me, maya)
    await befriend(db, xavier, kavon)
    group = await createGroup(db, groupmate, 'Weekend Crew')
    await addMember(db, group, me)

    // 24 friend posts (three authors, friends / world alternating): more than one page.
    for (let i = 0; i < 8; i += 1) {
      for (const author of [xavier, kavon, maya]) {
        const view = await createPost(db, author, {
          text: `${author.displayName} ${i}`,
          audience: i % 2 === 0 ? 'friends' : 'world',
        })
        friendPosts.add(view.post.id)
        if (author === xavier && i === 1) worldPostByXavier = view.post.id
      }
    }
    worldPostByStranger = (
      await createPost(db, stranger, { text: 'hello world', audience: 'world' })
    ).post.id
    friendsPostByStranger = (
      await createPost(db, stranger, { text: 'private', audience: 'friends' })
    ).post.id

    // Lives: Xavier + Kavon on camera in a standalone room; the group's own room.
    duoRoom = (await startStandaloneRoom(db, xavier, 'Cooking dinner')).room.id
    await joinRoom(db, duoRoom, kavon, 'camera', 'friends')
    groupRoom = (await startGroupRoom(db, groupmate, group)).room.id

    // The server clock is fixed just after the seed so the snapshot covers every row.
    ctx.clock.now = new Date(Date.now() + 1_000)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('page 1 for a Human: friend posts plus viewer-named Live cards, run as the caller', async () => {
    const bearer = ctx.tokens.for(me.as)
    const res = await server.handle(fakeRequest({ url: '/api/feed?scope=friends', bearer }))
    expect(res.status).toBe(200)
    const page = FeedPageDtoSchema.parse(res.body)
    expect(page).toMatchObject({
      scope: 'friends',
      areaName: null,
      snapshotAt: ctx.clock.now.toISOString(),
    })
    expect(page.cards).toHaveLength(FEED_PAGE_SIZE)
    expect(page.nextCursor).not.toBeNull()

    const lives = page.cards.filter(isLive)
    expect(lives.map((card) => card.title).sort()).toEqual([
      'Weekend Crew is live',
      'Xavier + Kavon are live',
    ])
    expect(lives.find((card) => card.roomId === duoRoom)).toMatchObject({
      id: duoRoom,
      participantNames: ['Xavier', 'Kavon'],
      participantAvatars: [null, null],
      participantCount: 2,
      visibility: 'friends',
      contextTitle: null,
    })
    expect(lives.find((card) => card.roomId === groupRoom)).toMatchObject({
      participantNames: ['Groupmate'],
      participantCount: 1,
      visibility: 'group',
      contextTitle: 'Weekend Crew',
    })

    const posts = page.cards.filter((card) => !isLive(card))
    expect(posts).toHaveLength(FEED_PAGE_SIZE - lives.length)
    for (const card of posts) {
      if (card.kind !== 'post') throw new Error(`unexpected card ${card.kind}`)
      expect(card.id).toBe(card.post.id)
      expect(friendPosts.has(card.id)).toBe(true)
      expect([xavier.humanId, kavon.humanId, maya.humanId]).toContain(card.author.humanId)
    }

    // The candidates were fetched as the caller with the fixed snapshot.
    expect(ctx.callsTo('feed_candidates').at(-1)).toMatchObject({
      client: `user:${bearer}`,
      as: me.as,
      args: { scope: 'friends', area_id: null, snapshot_at: ctx.clock.now.toISOString() },
    })
  })

  it('page 2 follows the cursor: same snapshot, no Lives, no repeats, then the end', async () => {
    const bearer = ctx.tokens.for(me.as)
    const first = FeedPageDtoSchema.parse(
      (await server.handle(fakeRequest({ url: '/api/feed?scope=friends', bearer }))).body,
    )
    expect(first.nextCursor).not.toBeNull()
    // Time moves on; the cursor pins the snapshot so the candidate set and the scores repeat.
    ctx.clock.now = new Date(ctx.clock.now.getTime() + 60_000)
    const second = FeedPageDtoSchema.parse(
      (
        await server.handle(
          fakeRequest({
            url: `/api/feed?scope=friends&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
            bearer,
          }),
        )
      ).body,
    )
    expect(second.snapshotAt).toBe(first.snapshotAt)
    expect(ctx.callsTo('feed_candidates').at(-1)?.args['snapshot_at']).toBe(first.snapshotAt)
    expect(second.cards.every((card) => card.kind === 'post')).toBe(true)
    const firstIds = first.cards.filter((card) => !isLive(card)).map((card) => card.id)
    const secondIds = second.cards.map((card) => card.id)
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([])
    expect(new Set([...firstIds, ...secondIds])).toEqual(friendPosts)
    expect(second.cards).toHaveLength(friendPosts.size - firstIds.length)
    expect(second.nextCursor).toBeNull()
  })

  it('a Visitor reads World without a bearer; any other scope without a bearer is 401', async () => {
    const res = await server.handle(fakeRequest({ url: '/api/feed?scope=world' }))
    expect(res.status).toBe(200)
    const page = FeedPageDtoSchema.parse(res.body)
    expect(page.scope).toBe('world')
    const ids = page.cards.map((card) => card.id)
    expect(ids).toContain(worldPostByStranger)
    expect(ids).toContain(worldPostByXavier)
    expect(ids).not.toContain(friendsPostByStranger)
    expect(page.cards.every((card) => card.kind === 'post' && card.post.audience === 'world')).toBe(
      true,
    )
    expect(ctx.callsTo('feed_candidates').at(-1)).toMatchObject({ client: 'anon', as: 'visitor' })

    const before = ctx.calls.length
    for (const scope of ['friends', 'neighborhood', 'city']) {
      const denied = await server.handle(fakeRequest({ url: `/api/feed?scope=${scope}` }))
      expect(denied.status).toBe(401)
      expect(denied.body).toMatchObject({ error: { code: 'not_authenticated' } })
    }
    expect(ctx.calls).toHaveLength(before)
  })

  it('a bearer the database cannot verify is 401, never a 500', async () => {
    const res = await server.handle(
      fakeRequest({ url: '/api/feed?scope=friends', bearer: 'not-a-session' }),
    )
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ error: { code: 'not_authenticated' } })
  })
})
