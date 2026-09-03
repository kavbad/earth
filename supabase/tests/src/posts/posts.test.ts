/**
 * Post RPCs (DB_API §4; spec §29–§31, §72, §83; SCREEN 06–07): creation and validation, area
 * context, replies (audience narrowing, reply policy), reactions, hides, soft delete, reply paging
 * and the canonical visibility rules of earth.can_view_post for every caller kind.
 */
import { PostMediaDtoSchema } from '@earth/domain'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDb, type TestDb } from '../harness'
import {
  RepliesPageSchema,
  befriend,
  block,
  canSee,
  count,
  createArea,
  createGuest,
  createHuman,
  createMedia,
  createPlace,
  createPost,
  createUnclaimed,
  getPost,
  human,
  postArgs,
  postRow,
  resetRateLimits,
  setContext,
  setFlag,
  setHuman,
  setSetting,
  type Human,
} from './fixtures'

describe('posts (DB_API §4)', () => {
  let db: TestDb
  let sf: string
  let mission: string
  let marina: string
  let la: string
  let alice: Human
  let bob: Human
  let carol: Human

  beforeAll(async () => {
    db = await createTestDb()
    sf = await createArea(db, { name: 'San Francisco', slug: 'sf', type: 'city' })
    mission = await createArea(db, { name: 'Mission', slug: 'mission', type: 'neighborhood', parentAreaId: sf })
    marina = await createArea(db, { name: 'Marina', slug: 'marina', type: 'neighborhood', parentAreaId: sf })
    la = await createArea(db, { name: 'Los Angeles', slug: 'la', type: 'city' })
    alice = await human(db, 'Alice')
    bob = await human(db, 'Bob')
    carol = await human(db, 'Carol')
    await befriend(db, alice, bob)
    await setContext(db, alice, { currentAreaId: mission, currentCityId: sf })
  })

  afterAll(async () => {
    await db.drop()
  })

  // Every test starts with a fresh rate-limit budget (the 20/h limit has its own test).
  beforeEach(async () => {
    await resetRateLimits(db)
  })

  describe('post_create', () => {
    it('returns a PostViewDto with author, counts, empty media and no place', async () => {
      const view = await createPost(db, alice, { text: 'first light', audience: 'friends' })
      expect(view.post).toMatchObject({
        authorHumanId: alice.humanId,
        type: 'text',
        text: 'first light',
        audience: 'friends',
        areaId: null,
        placeId: null,
        replyPolicy: 'everyone_eligible',
        resharePolicy: 'allowed_within_audience',
        parentPostId: null,
        rootPostId: null,
        editedAt: null,
        deletedAt: null,
      })
      expect(view.author).toMatchObject({ humanId: alice.humanId, displayName: 'Alice', handle: alice.handle })
      expect(view).toMatchObject({ reactionCount: 0, replyCount: 0, myReaction: null, place: null, media: [] })
      expect(await postRow(db, view.post.id)).toMatchObject({ status: 'active', audience: 'friends' })
    })

    it('only active Humans may post', async () => {
      await db.expectError(db.rpc('post_create', postArgs({}), 'visitor'), 'not_authenticated')
      const guest = await createGuest(db)
      await db.expectError(db.rpc('post_create', postArgs({}), guest.as), 'not_a_human')
      const unclaimed = await createUnclaimed(db)
      await db.expectError(db.rpc('post_create', postArgs({}), unclaimed.as), 'not_a_human')
      const pending = await createHuman(db, { handle: 'pendingposter', status: 'pending' })
      await db.expectError(db.rpc('post_create', postArgs({}), pending.as), 'not_a_human')
      const suspended = await createHuman(db, { handle: 'suspendedposter', status: 'suspended' })
      await db.expectError(db.rpc('post_create', postArgs({}), suspended.as), 'human_not_active')
      await db.expectError(db.rpc('post_create', postArgs({}), 'service'), 'not_a_human')
    })

    it('validates content: text or media, length, type consistency, media ownership and bucket', async () => {
      await db.expectError(db.rpc('post_create', postArgs({ text: '   ' }), alice.as), 'invalid_input')
      await db.expectError(db.rpc('post_create', postArgs({ text: null }), alice.as), 'invalid_input')
      await db.expectError(db.rpc('post_create', postArgs({ text: 'x'.repeat(2001) }), alice.as), 'invalid_input')
      const ok = await createPost(db, alice, { text: 'x'.repeat(2000) })
      expect(ok.post.text?.length).toBe(2000)
      await db.expectError(db.rpc('post_create', postArgs({ type: 'image', text: 'no media' }), alice.as), 'invalid_input')
      await db.expectError(db.rpc('post_create', postArgs({ type: 'video', text: null }), alice.as), 'invalid_input')
      const mine = await createMedia(db, alice)
      // A text post carries no media; media posts carry media.
      await db.expectError(db.rpc('post_create', postArgs({ type: 'text', text: 'hi', media: [mine] }), alice.as), 'invalid_input')
      const bobs = await createMedia(db, bob)
      await db.expectError(db.rpc('post_create', postArgs({ type: 'image', text: null, media: [bobs] }), alice.as), 'invalid_input')
      const avatar = await createMedia(db, alice, { bucket: 'avatars', key: 'alice/avatar.jpg' })
      await db.expectError(db.rpc('post_create', postArgs({ type: 'image', text: null, media: [avatar] }), alice.as), 'invalid_input')
      const pdf = await createMedia(db, alice, { contentType: 'application/pdf', key: 'alice/doc.pdf' })
      await db.expectError(db.rpc('post_create', postArgs({ type: 'image', text: null, media: [pdf] }), alice.as), 'invalid_input')
      await db.expectError(db.rpc('post_create', postArgs({ type: 'image', text: null, media: [mine, mine] }), alice.as), 'invalid_input')
      await db.expectError(
        db.rpc('post_create', postArgs({ type: 'image', text: null, media: [mine], provenance: ['edited', 'edited'] }), alice.as),
        'invalid_input',
      )
      const eleven: string[] = []
      for (let i = 0; i < 11; i += 1) eleven.push(await createMedia(db, alice))
      await db.expectError(db.rpc('post_create', postArgs({ type: 'image', text: null, media: eleven }), alice.as), 'invalid_input')
    })

    it('stores media in order with type from the object and provenance per item', async () => {
      const image = await createMedia(db, alice, { key: 'alice/a.jpg', width: 1200, height: 800 })
      const video = await createMedia(db, alice, { key: 'alice/b.mp4', contentType: 'video/mp4', width: null, height: null, durationMs: 4200 })
      const view = await createPost(db, alice, {
        type: 'image',
        text: 'two shots',
        audience: 'world',
        media: [image, video],
        provenance: ['earth_capture', 'uploaded'],
      })
      expect(view.media).toHaveLength(2)
      expect(view.media.map((m) => PostMediaDtoSchema.parse(m).mediaType)).toEqual(['image', 'video'])
      expect(view.media[0]).toMatchObject({ postId: view.post.id, width: 1200, height: 800, durationMs: null, provenance: 'earth_capture' })
      expect(view.media[1]).toMatchObject({ width: 0, height: 0, durationMs: 4200, provenance: 'uploaded' })
      expect(view.media[0]?.url).toMatch(/^https:\/\/earth\.social\/api\/media\/media\/alice\/a\.jpg$/)
      const noProvenance = await createPost(db, alice, { type: 'image', text: null, media: [await createMedia(db, alice)] })
      expect(noProvenance.media[0]?.provenance).toBe('unknown')
    })

    it('neighborhood and city posts take their area from human_context and never store coordinates', async () => {
      const neighborhood = await createPost(db, alice, { text: 'block party', audience: 'neighborhood' })
      expect(neighborhood.post.areaId).toBe(mission)
      const city = await createPost(db, alice, { text: 'city walk', audience: 'city' })
      expect(city.post.areaId).toBe(sf)
      // An explicit area is honoured (city post tagged to a neighborhood for local proximity).
      const tagged = await createPost(db, alice, { text: 'in marina', audience: 'city', areaId: marina })
      expect(tagged.post.areaId).toBe(marina)
      // A friends/world post may carry an explicit area tag or none.
      const world = await createPost(db, alice, { text: 'hello', audience: 'world' })
      expect(world.post.areaId).toBeNull()
      await db.expectError(db.rpc('post_create', postArgs({ audience: 'world', areaId: '00000000-0000-4000-8000-000000000000' }), alice.as), 'area_not_found')
      // No context at all → area_not_found (spec §74: area context is required, not GPS).
      await db.expectError(db.rpc('post_create', postArgs({ audience: 'neighborhood' }), carol.as), 'area_not_found')
      await db.expectError(db.rpc('post_create', postArgs({ audience: 'city' }), carol.as), 'area_not_found')
      // A city is derived from the current neighborhood or the home city when no current city is set.
      await setContext(db, carol, { currentAreaId: marina })
      expect((await createPost(db, carol, { text: 'derived', audience: 'city' })).post.areaId).toBe(sf)
      await setContext(db, carol, { homeCityId: la })
      expect((await createPost(db, carol, { text: 'home', audience: 'city' })).post.areaId).toBe(la)
      await db.expectError(db.rpc('post_create', postArgs({ audience: 'neighborhood' }), carol.as), 'area_not_found')
      await setContext(db, carol, {})
      const columns = await db.sql.query(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'posts' and (column_name ilike '%lat%' or column_name ilike '%lng%' or column_name ilike '%location%' or udt_name = 'geometry')`,
      )
      expect(columns.rows).toEqual([])
    })

    it('audience flags gate root posts', async () => {
      await setFlag(db, 'NEIGHBORHOOD_ENABLED', false)
      await db.expectError(db.rpc('post_create', postArgs({ audience: 'neighborhood' }), alice.as), 'feature_disabled')
      await setFlag(db, 'NEIGHBORHOOD_ENABLED', true)
      await setFlag(db, 'CITY_ENABLED', false)
      await db.expectError(db.rpc('post_create', postArgs({ audience: 'city' }), alice.as), 'feature_disabled')
      await setFlag(db, 'CITY_ENABLED', true)
      await setFlag(db, 'WORLD_ENABLED', false)
      await db.expectError(db.rpc('post_create', postArgs({ audience: 'world' }), alice.as), 'feature_disabled')
      await setFlag(db, 'WORLD_ENABLED', true)
    })

    it('place tags are explicit: a public place resolves to a PlaceDto, an unknown or private one is rejected', async () => {
      const park = await createPlace(db, mission)
      const view = await createPost(db, alice, { type: 'moment', text: 'sunny', audience: 'friends', placeId: park })
      expect(view.post.placeId).toBe(park)
      expect(view.place).toMatchObject({ id: park, name: 'Dolores Park', areaId: mission, areaName: 'Mission', category: 'park', visibility: 'public' })
      expect(view.place?.lat).toBeCloseTo(37.7596)
      expect(view.place?.lng).toBeCloseTo(-122.427)
      await db.expectError(db.rpc('post_create', postArgs({ placeId: '00000000-0000-4000-8000-000000000000' }), alice.as), 'invalid_input')
      const secret = await createPlace(db, mission, 'Hideout', 'private')
      await db.expectError(db.rpc('post_create', postArgs({ placeId: secret }), alice.as), 'invalid_input')
    })

    it('is rate limited to 20 posts per hour per Human', async () => {
      const prolific = await human(db, 'Prolific')
      for (let i = 0; i < 20; i += 1) await createPost(db, prolific, { text: `post ${i}` })
      await db.expectError(db.rpc('post_create', postArgs({ text: 'one too many' }), prolific.as), 'rate_limited')
      // Other Humans keep their own budget.
      await createPost(db, alice, { text: 'still fine' })
    })
  })

  describe('replies (spec §31, §72; SCREEN 07)', () => {
    it('a reply requested as world to a friends post is stored as friends — never audience_too_wide, never wider', async () => {
      const root = await createPost(db, alice, { text: 'friends only', audience: 'friends' })
      const reply = await createPost(db, bob, { text: 'me too', audience: 'world', parentPostId: root.post.id })
      expect(reply.post).toMatchObject({ audience: 'friends', parentPostId: root.post.id, rootPostId: root.post.id })
      // A narrower request is kept.
      const cityRoot = await createPost(db, alice, { text: 'city', audience: 'city' })
      const narrower = await createPost(db, bob, { text: 'friends reply', audience: 'friends', parentPostId: cityRoot.post.id })
      expect(narrower.post.audience).toBe('friends')
      // Replies to a neighborhood/city thread inherit the root's area.
      const wide = await createPost(db, bob, { text: 'city reply', audience: 'world', parentPostId: cityRoot.post.id })
      expect(wide.post).toMatchObject({ audience: 'city', areaId: sf })
      // The reply is not visible beyond the root's audience (a stranger cannot read a reply to a friends post).
      expect(await canSee(db, reply.post.id, carol.as)).toBe(false)
      expect(await canSee(db, reply.post.id, 'visitor')).toBe(false)
      expect(await canSee(db, reply.post.id, alice.as)).toBe(true)
    })

    it('replies to replies keep the thread root and maintain reply_count on the direct parent', async () => {
      const root = await createPost(db, alice, { text: 'root', audience: 'world' })
      const first = await createPost(db, bob, { text: 'first', audience: 'world', parentPostId: root.post.id })
      const nested = await createPost(db, carol, { text: 'nested', audience: 'world', parentPostId: first.post.id })
      expect(nested.post).toMatchObject({ parentPostId: first.post.id, rootPostId: root.post.id })
      expect((await getPost(db, root.post.id, alice.as)).replyCount).toBe(1)
      expect((await getPost(db, first.post.id, alice.as)).replyCount).toBe(1)
      await db.rpc('post_delete', { post_id: nested.post.id }, carol.as)
      expect((await getPost(db, first.post.id, alice.as)).replyCount).toBe(0)
      expect(await postRow(db, root.post.id)).toMatchObject({ reply_count: 1 })
    })

    it('reply_policy is enforced against the root: none → reply_not_allowed, friends → friends only, mentioned admits nobody else', async () => {
      const closed = await createPost(db, alice, { text: 'no replies', audience: 'world', replyPolicy: 'none' })
      await db.expectError(db.rpc('post_create', postArgs({ text: 'hey', audience: 'world', parentPostId: closed.post.id }), bob.as), 'reply_not_allowed')
      await db.expectError(db.rpc('post_create', postArgs({ text: 'hey', audience: 'world', parentPostId: closed.post.id }), carol.as), 'reply_not_allowed')
      // The author may continue their own thread.
      const own = await createPost(db, alice, { text: 'ps', audience: 'world', parentPostId: closed.post.id })
      expect(own.post.rootPostId).toBe(closed.post.id)
      // The root's policy applies to nested replies too.
      await db.expectError(db.rpc('post_create', postArgs({ text: 'nested', audience: 'world', parentPostId: own.post.id }), bob.as), 'reply_not_allowed')

      const friendsOnly = await createPost(db, alice, { text: 'friends may reply', audience: 'world', replyPolicy: 'friends' })
      await db.expectError(db.rpc('post_create', postArgs({ text: 'hey', audience: 'world', parentPostId: friendsOnly.post.id }), carol.as), 'reply_not_allowed')
      await createPost(db, bob, { text: 'friend here', audience: 'world', parentPostId: friendsOnly.post.id })

      const mentioned = await createPost(db, alice, { text: 'mentions only', audience: 'world', replyPolicy: 'mentioned' })
      await db.expectError(db.rpc('post_create', postArgs({ text: 'hey', audience: 'world', parentPostId: mentioned.post.id }), bob.as), 'reply_not_allowed')
    })

    it('replying needs a visible, active parent; blocks refuse', async () => {
      const hidden = await createPost(db, alice, { text: 'friends', audience: 'friends' })
      await db.expectError(db.rpc('post_create', postArgs({ text: 'hi', parentPostId: hidden.post.id }), carol.as), 'post_not_found')
      await db.expectError(db.rpc('post_create', postArgs({ text: 'hi', parentPostId: '00000000-0000-4000-8000-000000000000' }), carol.as), 'post_not_found')
      const removed = await createPost(db, alice, { text: 'going away', audience: 'world' })
      await db.rpc('post_delete', { post_id: removed.post.id }, alice.as)
      await db.expectError(db.rpc('post_create', postArgs({ text: 'hi', parentPostId: removed.post.id }), bob.as), 'post_not_found')
      // The author can still see their removed post but cannot reply to it.
      await db.expectError(db.rpc('post_create', postArgs({ text: 'hi', parentPostId: removed.post.id }), alice.as), 'post_not_found')
      const dave = await human(db, 'Dave')
      const root = await createPost(db, dave, { text: 'open', audience: 'world' })
      await block(db, dave, carol)
      await db.expectError(db.rpc('post_create', postArgs({ text: 'hi', parentPostId: root.post.id }), carol.as), 'post_not_found')
    })

    it('post_replies pages direct replies oldest first with a stable cursor', async () => {
      const root = await createPost(db, alice, { text: 'thread', audience: 'world' })
      const ids: string[] = []
      for (const author of [bob, carol, bob]) {
        ids.push((await createPost(db, author, { text: `r${ids.length}`, audience: 'world', parentPostId: root.post.id })).post.id)
      }
      const page1 = RepliesPageSchema.parse(await db.rpc('post_replies', { post_id: root.post.id, cursor: null, limit: 2 }, 'visitor'))
      expect(page1.replies.map((r) => r.post.id)).toEqual(ids.slice(0, 2))
      expect(page1.nextCursor).toBe(ids[1])
      const page2 = RepliesPageSchema.parse(await db.rpc('post_replies', { post_id: root.post.id, cursor: page1.nextCursor, limit: 2 }, 'visitor'))
      expect(page2.replies.map((r) => r.post.id)).toEqual([ids[2]])
      expect(page2.nextCursor).toBeNull()
      await db.expectError(db.rpc('post_replies', { post_id: root.post.id, cursor: 'nope', limit: 2 }, 'visitor'), 'invalid_input')
      await db.expectError(db.rpc('post_replies', { post_id: root.post.id, cursor: root.post.id, limit: 2 }, 'visitor'), 'invalid_input')
      // post_get carries the first page; a reply by someone the viewer blocked is not shown to them.
      const detail = await getPost(db, root.post.id, alice.as)
      expect(detail.replies.map((r) => r.post.id)).toEqual(ids)
      const eve = await human(db, 'Eve')
      await block(db, eve, carol)
      const forEve = await getPost(db, root.post.id, eve.as)
      expect(forEve.replies.map((r) => r.post.id)).toEqual([ids[0], ids[2]])
    })
  })

  describe('visibility — earth.can_view_post (spec §71; DB_API §4)', () => {
    it('a friends post is visible to the author and friends only: never to non-friends, visitors, guests, or a friend blocked either way', async () => {
      const post = await createPost(db, alice, { text: 'friends', audience: 'friends' })
      expect(await canSee(db, post.post.id, alice.as)).toBe(true)
      expect(await canSee(db, post.post.id, bob.as)).toBe(true)
      expect(await canSee(db, post.post.id, carol.as)).toBe(false)
      expect(await canSee(db, post.post.id, 'visitor')).toBe(false)
      expect(await canSee(db, post.post.id, (await createGuest(db)).as)).toBe(false)
      expect(await canSee(db, post.post.id, (await createHuman(db, { handle: 'claimingviewer', status: 'pending' })).as)).toBe(false)
      const blockedFriend = await human(db, 'Blockedfriend')
      await befriend(db, alice, blockedFriend)
      expect(await canSee(db, post.post.id, blockedFriend.as)).toBe(true)
      await block(db, alice, blockedFriend)
      expect(await canSee(db, post.post.id, blockedFriend.as)).toBe(false)
      await db.sql.query('delete from public.blocks where blocker_human_id = $1', [alice.humanId])
      await block(db, blockedFriend, alice)
      expect(await canSee(db, post.post.id, blockedFriend.as)).toBe(false)
      // The author sees their own post whatever the blocks.
      expect(await canSee(db, post.post.id, alice.as)).toBe(true)
    })

    it('a neighborhood post is visible in the area, in its children, to friends elsewhere; not to strangers in another neighborhood', async () => {
      const post = await createPost(db, alice, { text: 'block party', audience: 'neighborhood' })
      expect(post.post.areaId).toBe(mission)
      const local = await human(db, 'Local')
      await setContext(db, local, { currentAreaId: mission, currentCityId: sf })
      expect(await canSee(db, post.post.id, local.as)).toBe(true)
      const nextDoor = await human(db, 'Nextdoor')
      await setContext(db, nextDoor, { currentAreaId: marina, currentCityId: sf })
      expect(await canSee(db, post.post.id, nextDoor.as)).toBe(false)
      const noContext = await human(db, 'Nocontext')
      expect(await canSee(db, post.post.id, noContext.as)).toBe(false)
      // Friends elsewhere (LA) still see it.
      await setContext(db, bob, { currentCityId: la })
      expect(await canSee(db, post.post.id, bob.as)).toBe(true)
      expect(await canSee(db, post.post.id, 'visitor')).toBe(false)
      // A post tagged at city level with neighborhood audience reaches Humans whose current area is inside it.
      const cityTagged = await createPost(db, alice, { text: 'anywhere in sf', audience: 'neighborhood', areaId: sf })
      expect(await canSee(db, cityTagged.post.id, nextDoor.as)).toBe(true)
      const angeleno = await human(db, 'Angeleno')
      await setContext(db, angeleno, { currentCityId: la })
      expect(await canSee(db, cityTagged.post.id, angeleno.as)).toBe(false)
    })

    it('a city post is visible to Humans whose current or home city matches (or whose current area lies in it)', async () => {
      const post = await createPost(db, alice, { text: 'city', audience: 'city' })
      expect(post.post.areaId).toBe(sf)
      const sameCity = await human(db, 'Samecity')
      await setContext(db, sameCity, { currentCityId: sf })
      expect(await canSee(db, post.post.id, sameCity.as)).toBe(true)
      const homeSf = await human(db, 'Homesf')
      await setContext(db, homeSf, { currentCityId: la, homeCityId: sf })
      expect(await canSee(db, post.post.id, homeSf.as)).toBe(true)
      const inMarina = await human(db, 'Inmarina')
      await setContext(db, inMarina, { currentAreaId: marina })
      expect(await canSee(db, post.post.id, inMarina.as)).toBe(true)
      const angeleno = await human(db, 'Angeleno2')
      await setContext(db, angeleno, { currentCityId: la, homeCityId: la })
      expect(await canSee(db, post.post.id, angeleno.as)).toBe(false)
      expect(await canSee(db, post.post.id, 'visitor')).toBe(false)
      // A city post tagged to a neighborhood still reaches the whole city.
      const tagged = await createPost(db, alice, { text: 'marina thing', audience: 'city', areaId: marina })
      expect(await canSee(db, tagged.post.id, sameCity.as)).toBe(true)
      expect(await canSee(db, tagged.post.id, angeleno.as)).toBe(false)
    })

    it('a world post is visible to everyone; visitors and guests only while PUBLIC_WORLD_ENABLED', async () => {
      const post = await createPost(db, alice, { text: 'world', audience: 'world' })
      const guest = await createGuest(db)
      const stranger = await human(db, 'Stranger')
      expect(await canSee(db, post.post.id, 'visitor')).toBe(true)
      expect(await canSee(db, post.post.id, guest.as)).toBe(true)
      expect(await canSee(db, post.post.id, stranger.as)).toBe(true)
      await setFlag(db, 'PUBLIC_WORLD_ENABLED', false)
      expect(await canSee(db, post.post.id, 'visitor')).toBe(false)
      expect(await canSee(db, post.post.id, guest.as)).toBe(false)
      expect(await canSee(db, post.post.id, stranger.as)).toBe(true)
      // RLS follows the same rule.
      const asVisitor = await db.asRole('visitor', (c) => c.query('select id from public.posts where id = $1', [post.post.id]))
      expect(asVisitor.rowCount).toBe(0)
      await setFlag(db, 'PUBLIC_WORLD_ENABLED', true)
      const again = await db.asRole('visitor', (c) => c.query('select id from public.posts where id = $1', [post.post.id]))
      expect(again.rowCount).toBe(1)
    })

    it('fixture Humans are hidden from visitors in production; posts of inactive Humans vanish', async () => {
      const fixture = await human(db, 'Fixture')
      await setHuman(db, fixture, { isFixture: true })
      const post = await createPost(db, fixture, { text: 'seeded', audience: 'world' })
      expect(await canSee(db, post.post.id, 'visitor')).toBe(true)
      await setSetting(db, 'environment', 'production')
      expect(await canSee(db, post.post.id, 'visitor')).toBe(false)
      expect(await canSee(db, post.post.id, alice.as)).toBe(true)
      await setSetting(db, 'environment', 'development')
      expect(await canSee(db, post.post.id, 'visitor')).toBe(true)
      await setHuman(db, fixture, { status: 'suspended' })
      expect(await canSee(db, post.post.id, 'visitor')).toBe(false)
      expect(await canSee(db, post.post.id, alice.as)).toBe(false)
      expect(await canSee(db, post.post.id, fixture.as)).toBe(false)
      await setHuman(db, fixture, { status: 'active' })
    })
  })

  describe('reactions, hides and deletion', () => {
    it('post_reaction_set upserts one reaction per Human and clears it with null', async () => {
      const post = await createPost(db, alice, { text: 'react', audience: 'world' })
      expect(await db.rpc('post_reaction_set', { post_id: post.post.id, reaction_type: 'heart' }, bob.as)).toEqual({
        postId: post.post.id,
        myReaction: 'heart',
        reactionCount: 1,
      })
      expect(await db.rpc('post_reaction_set', { post_id: post.post.id, reaction_type: ' fire ' }, bob.as)).toMatchObject({ myReaction: 'fire', reactionCount: 1 })
      expect(await db.rpc('post_reaction_set', { post_id: post.post.id, reaction_type: 'heart' }, carol.as)).toMatchObject({ reactionCount: 2 })
      const forBob = await getPost(db, post.post.id, bob.as)
      expect(forBob).toMatchObject({ myReaction: 'fire', reactionCount: 2 })
      expect((await getPost(db, post.post.id, 'visitor')).myReaction).toBeNull()
      expect(await db.rpc('post_reaction_set', { post_id: post.post.id, reaction_type: null }, bob.as)).toMatchObject({ myReaction: null, reactionCount: 1 })
      expect(await db.rpc('post_reaction_set', { post_id: post.post.id, reaction_type: '' }, bob.as)).toMatchObject({ myReaction: null, reactionCount: 1 })
      await db.expectError(db.rpc('post_reaction_set', { post_id: post.post.id, reaction_type: 'x'.repeat(17) }, bob.as), 'invalid_input')
      await db.expectError(db.rpc('post_reaction_set', { post_id: post.post.id, reaction_type: 'heart' }, 'visitor'), 'not_authenticated')
      await db.expectError(db.rpc('post_reaction_set', { post_id: post.post.id, reaction_type: 'heart' }, (await createGuest(db)).as), 'not_a_human')
      const friendsPost = await createPost(db, alice, { text: 'friends', audience: 'friends' })
      await db.expectError(db.rpc('post_reaction_set', { post_id: friendsPost.post.id, reaction_type: 'heart' }, carol.as), 'post_not_found')
      await db.expectError(db.rpc('post_reaction_set', { post_id: '00000000-0000-4000-8000-000000000000', reaction_type: 'heart' }, bob.as), 'post_not_found')
      expect(await postRow(db, post.post.id)).toMatchObject({ reaction_count: 1 })
    })

    it('post_hide is idempotent, needs a visible post and never hides the post from a direct fetch', async () => {
      const post = await createPost(db, alice, { text: 'hide me', audience: 'world' })
      expect(await db.rpc('post_hide', { post_id: post.post.id }, bob.as)).toEqual({ postId: post.post.id, hidden: true })
      expect(await db.rpc('post_hide', { post_id: post.post.id }, bob.as)).toEqual({ postId: post.post.id, hidden: true })
      expect(await count(db, 'public.post_hides', 'post_id = $1', [post.post.id])).toBe(1)
      expect(await canSee(db, post.post.id, bob.as)).toBe(true)
      await db.expectError(db.rpc('post_hide', { post_id: post.post.id }, 'visitor'), 'not_authenticated')
      const friendsPost = await createPost(db, alice, { text: 'friends', audience: 'friends' })
      await db.expectError(db.rpc('post_hide', { post_id: friendsPost.post.id }, carol.as), 'post_not_found')
    })

    it('post_delete is a soft delete by the author (or the service): content leaves distribution at once', async () => {
      const media = await createMedia(db, alice)
      const post = await createPost(db, alice, { type: 'image', text: 'bye', audience: 'world', media: [media] })
      await db.rpc('post_reaction_set', { post_id: post.post.id, reaction_type: 'heart' }, bob.as)
      await db.expectError(db.rpc('post_delete', { post_id: post.post.id }, bob.as), 'forbidden')
      await db.expectError(db.rpc('post_delete', { post_id: post.post.id }, 'visitor'), 'not_authenticated')
      const friendsPost = await createPost(db, alice, { text: 'friends', audience: 'friends' })
      await db.expectError(db.rpc('post_delete', { post_id: friendsPost.post.id }, carol.as), 'post_not_found')

      const deleted = await db.rpc('post_delete', { post_id: post.post.id }, alice.as)
      expect(deleted).toMatchObject({ post: { id: post.post.id, text: null }, media: [] })
      expect(await postRow(db, post.post.id)).toMatchObject({ status: 'removed', text: null })
      expect(await count(db, 'public.post_media', 'post_id = $1', [post.post.id])).toBe(0)
      expect(await canSee(db, post.post.id, bob.as)).toBe(false)
      expect(await canSee(db, post.post.id, 'visitor')).toBe(false)
      const own = await getPost(db, post.post.id, alice.as)
      expect(own.post.deletedAt).not.toBeNull()
      // Idempotent; the tombstone is frozen.
      await db.rpc('post_delete', { post_id: post.post.id }, alice.as)
      await expect(db.sql.query(`update public.posts set status = 'active', deleted_at = null where id = $1`, [post.post.id])).rejects.toThrow('invalid_input')
      await expect(db.sql.query(`update public.posts set text = 'back' where id = $1`, [post.post.id])).resolves.toBeDefined()
      expect((await postRow(db, post.post.id)).text).toBeNull()
      // The service may remove any post (moderation).
      const other = await createPost(db, carol, { text: 'reported', audience: 'world' })
      await db.rpc('post_delete', { post_id: other.post.id }, 'service')
      expect((await postRow(db, other.post.id)).status).toBe('removed')
      await db.expectError(db.rpc('post_delete', { post_id: '00000000-0000-4000-8000-000000000000' }, 'service'), 'post_not_found')
    })

    it('post_get needs a visible post', async () => {
      await db.expectError(db.rpc('post_get', { post_id: '00000000-0000-4000-8000-000000000000' }, alice.as), 'post_not_found')
      await db.expectError(db.rpc('post_get', { post_id: null }, alice.as), 'invalid_input')
    })
  })
})
