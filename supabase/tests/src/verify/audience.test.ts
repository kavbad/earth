/**
 * Adversarial verification of the "audience" invariant cluster (spec §29, §31, §52, §71–§76, §128):
 *
 *   - Audience permission is server-authoritative: clients hold no write privilege on post,
 *     reaction, hide or location rows; a requested audience is clamped by the server; browsing an
 *     area (feed `area_id`, map box) never widens what the viewer's own context allows.
 *   - Replies / reshares never exceed the root audience: a reply in a friends / neighborhood / city
 *     thread stays invisible beyond the root's audience on every read surface — post_get,
 *     post_replies, RLS on posts / post_media / post_reactions, search, every feed scope, the map,
 *     posts_by_author — whatever audience the replier asked for, and no reshare path exists.
 *   - Private group / chat content never appears in World: `feed_candidates('world')`,
 *     `public_feed`, `map_objects('world')` and `search` carry no message, no friends /
 *     neighborhood / city post, no group-visibility room — and a direct room opened to World never
 *     names the other member of the chat.
 *   - Exact location is never inferred as permission: nothing but an explicit share stores a
 *     coordinate; feed / post payloads carry areas and explicit Places only; a Live is pinned at
 *     its area centroid even for the friend who holds the host's precise share; a Human's area
 *     context is theirs alone.
 *
 * Every sequence is expressed as RPC calls by specific callers; raw rows only set up what no RPC
 * can (friendships, area context by id). One scratch database per file.
 */
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  BASE_AREA_SLUGS,
  POINTS,
  SF_CENTROID,
  areaBySlug,
  coordinateDigest,
  placeByKey,
  tablesMentioning,
} from '../geo/fixtures'
import {
  MISSION_BBOX,
  NORTH_BEACH_BBOX,
  SF_BBOX,
  WASHINGTON_SQUARE,
  endRoom,
  mapObjects,
  openUp,
  type Bbox,
} from '../map-search/fixtures'
import { createMedia, postArgs, type FeedResult } from '../posts/fixtures'
import {
  addMember,
  befriend,
  canSee,
  createGroup,
  createGuest,
  createHuman,
  createPost,
  createRoomInvite,
  createShare,
  directConversation,
  errorCode,
  feed,
  getPost,
  getRoom,
  human,
  isPermissionDenied,
  resetAllRateLimits,
  sendMessage,
  setContext,
  startGroupRoom,
  startStandaloneRoom,
  visibleShares,
  type Human,
} from '../safety/fixtures'

const PLACE_ONLY = /(^|\.)place\.(lat|lng)$/
const COORDINATE_KEYS = new Set([
  'lat',
  'lng',
  'latitude',
  'longitude',
  'location',
  'coordinates',
  'position',
  'geometry',
  'centroid',
])

/** JSON paths whose key names a coordinate (`candidates[2].post.place.lat`). */
function coordinatePaths(value: unknown, path = ''): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, i) => coordinatePaths(item, `${path}[${i}]`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      const next = path === '' ? key : `${path}.${key}`
      return COORDINATE_KEYS.has(key) ? [next] : coordinatePaths(item, next)
    })
  }
  return []
}

function candidateIds(result: FeedResult): string[] {
  return result.candidates.map((c) => c.id)
}

describe('audience invariants — adversarial verification (spec §128)', () => {
  let db: TestDb
  let sf: string
  let mission: string
  let marina: string
  let northBeach: string
  let la: string
  let doloresPark: string
  let washingtonSquare: string
  const tag = randomUUID().slice(0, 8)

  beforeAll(async () => {
    db = await createTestDb()
    sf = await areaBySlug(db, BASE_AREA_SLUGS.sanFrancisco)
    mission = await areaBySlug(db, BASE_AREA_SLUGS.mission)
    marina = await areaBySlug(db, BASE_AREA_SLUGS.marina)
    northBeach = await areaBySlug(db, BASE_AREA_SLUGS.northBeach)
    la = await areaBySlug(db, BASE_AREA_SLUGS.losAngeles)
    doloresPark = await placeByKey(db, 'dolores-park')
    washingtonSquare = await placeByKey(db, 'washington-square-park')
  })

  beforeEach(async () => {
    await resetAllRateLimits(db)
  })

  afterAll(async () => {
    await db.drop()
  })

  /** Rows of a post the caller can read through RLS (posts, its media, its reactions). */
  async function rlsCounts(as: RoleSpec, postId: string) {
    return db.asRole(as, async (client) => {
      const n = async (sql: string) =>
        Number((await client.query<{ n: string }>(sql, [postId])).rows[0]?.n ?? '0')
      return {
        posts: await n('select count(*)::text as n from public.posts where id = $1'),
        post_media: await n('select count(*)::text as n from public.post_media where post_id = $1'),
        post_reactions: await n(
          'select count(*)::text as n from public.post_reactions where post_id = $1',
        ),
      }
    })
  }

  async function rawSearch(as: RoleSpec, q: string): Promise<{ posts: unknown[]; text: string }> {
    const result = await db.rpc<{ posts: unknown[] }>('search', { q, limit: 10 }, as)
    return { posts: result.posts, text: JSON.stringify(result) }
  }

  async function feedIdsAllScopes(as: RoleSpec, areaId: string | null = null): Promise<string[]> {
    const ids: string[] = []
    for (const scope of ['friends', 'neighborhood', 'city', 'world']) {
      const code = await errorCode(
        feed(db, scope, as, {
          areaId: scope === 'neighborhood' || scope === 'city' ? areaId : null,
        }),
      )
      if (code === 'area_not_found') continue
      expect(code).toBeNull()
      ids.push(
        ...candidateIds(
          await feed(db, scope, as, {
            areaId: scope === 'neighborhood' || scope === 'city' ? areaId : null,
          }),
        ),
      )
    }
    return ids
  }

  // -------------------------------------------------------------------------------------------
  describe('replies never exceed the root audience (spec §31, §72; SCREEN 07)', () => {
    let ann: Human
    let bea: Human
    let cal: Human
    let dan: Human
    let fay: Human
    let eve: Human
    let guest: RoleSpec
    let claiming: RoleSpec
    const secret = `thread-${tag}`

    beforeAll(async () => {
      ann = await human(db, 'Ann')
      bea = await human(db, 'Bea')
      cal = await human(db, 'Cal')
      dan = await human(db, 'Dan')
      fay = await human(db, 'Fay')
      eve = await human(db, 'Eve')
      await befriend(db, ann, bea)
      await befriend(db, ann, dan)
      // Cal is the replier's friend and stands in the root's own neighborhood: neither counts.
      await befriend(db, bea, cal)
      await setContext(db, ann, { currentAreaId: mission, currentCityId: sf })
      await setContext(db, bea, { currentCityId: la })
      await setContext(db, cal, { currentAreaId: mission, currentCityId: sf })
      await setContext(db, dan, { currentCityId: la })
      await setContext(db, fay, { currentAreaId: mission, currentCityId: sf })
      await setContext(db, eve, { currentAreaId: marina, currentCityId: sf })
      guest = (await createGuest(db)).as
      claiming = (await createHuman(db, { handle: `claim${tag}`, status: 'pending' })).as
    })

    it('a reply in a friends thread is invisible beyond the root author’s friends on every read surface, whatever audience the replier asked for', async () => {
      const root = await createPost(db, ann, { text: `${secret} root`, audience: 'friends' })
      const media = await createMedia(db, bea, { key: `bea/${tag}.jpg` })
      const reply = await createPost(db, bea, {
        type: 'image',
        text: `${secret} reply`,
        audience: 'world',
        areaId: sf,
        placeId: doloresPark,
        media: [media],
        parentPostId: root.post.id,
      })
      expect(reply.post).toMatchObject({
        audience: 'friends',
        rootPostId: root.post.id,
        parentPostId: root.post.id,
      })
      await db.rpc('post_reaction_set', { post_id: reply.post.id, reaction_type: 'heart' }, dan.as)

      for (const viewer of [cal.as, fay.as, 'visitor' as const, guest, claiming]) {
        expect(await canSee(db, reply.post.id, viewer)).toBe(false)
        expect(await canSee(db, root.post.id, viewer)).toBe(false)
        expect(await errorCode(db.rpc('post_replies', { post_id: reply.post.id }, viewer))).toBe(
          'post_not_found',
        )
        expect(await errorCode(db.rpc('post_replies', { post_id: root.post.id }, viewer))).toBe(
          'post_not_found',
        )
        expect(await rlsCounts(viewer, reply.post.id)).toEqual({
          posts: 0,
          post_media: 0,
          post_reactions: 0,
        })
      }
      expect(
        await errorCode(
          db.rpc('post_reaction_set', { post_id: reply.post.id, reaction_type: 'heart' }, cal.as),
        ),
      ).toBe('post_not_found')
      expect(await errorCode(db.rpc('post_hide', { post_id: reply.post.id }, cal.as))).toBe(
        'post_not_found',
      )
      // Cal: search, every feed scope, the author's profile posts and the map say nothing.
      const found = await rawSearch(cal.as, secret)
      expect(found.posts).toEqual([])
      expect(found.text).not.toContain(secret)
      expect(await feedIdsAllScopes(cal.as)).not.toContain(reply.post.id)
      expect(await feedIdsAllScopes(cal.as)).not.toContain(root.post.id)
      const byBea = await db.rpc<{ posts: Array<{ post: { id: string } }> }>(
        'posts_by_author',
        { handle: bea.handle },
        cal.as,
      )
      expect(byBea.posts.map((p) => p.post.id)).not.toContain(reply.post.id)
      const map = await mapObjects(db, 'friends', MISSION_BBOX, cal.as)
      expect(map.moments.map((m) => m.postId)).not.toContain(reply.post.id)
      // Dan, a friend of the root author, reads the whole thread (the surfaces are not empty).
      expect(await canSee(db, reply.post.id, dan.as)).toBe(true)
      expect(await rlsCounts(dan.as, reply.post.id)).toEqual({
        posts: 1,
        post_media: 1,
        post_reactions: 1,
      })
      expect((await getPost(db, root.post.id, dan.as)).replies.map((r) => r.post.id)).toEqual([
        reply.post.id,
      ])
      expect((await rawSearch(dan.as, secret)).text).toContain(reply.post.id)

      // A nested reply asked for as `city` narrows to the root as well.
      const nested = await createPost(db, dan, {
        text: `${secret} nested`,
        audience: 'city',
        parentPostId: reply.post.id,
      })
      expect(nested.post).toMatchObject({
        audience: 'friends',
        rootPostId: root.post.id,
        parentPostId: reply.post.id,
      })
      expect(await canSee(db, nested.post.id, cal.as)).toBe(false)
      expect(await canSee(db, nested.post.id, 'visitor')).toBe(false)
      expect(await canSee(db, nested.post.id, bea.as)).toBe(true)
    })

    it('a reply in a neighborhood thread reaches the neighborhood and the root author’s friends, never the next neighborhood or visitors', async () => {
      const root = await createPost(db, ann, {
        text: `${secret} block party`,
        audience: 'neighborhood',
      })
      expect(root.post.areaId).toBe(mission)
      const reply = await createPost(db, bea, {
        text: `${secret} from la`,
        audience: 'world',
        parentPostId: root.post.id,
      })
      expect(reply.post).toMatchObject({ audience: 'neighborhood', areaId: mission })
      expect(await canSee(db, reply.post.id, fay.as)).toBe(true)
      expect(await canSee(db, reply.post.id, dan.as)).toBe(true)
      for (const viewer of [eve.as, 'visitor' as const, guest, claiming]) {
        expect(await canSee(db, reply.post.id, viewer)).toBe(false)
        expect(await rlsCounts(viewer, reply.post.id)).toEqual({
          posts: 0,
          post_media: 0,
          post_reactions: 0,
        })
      }
      // Browsing the Mission explicitly does not let Eve (Marina) in.
      expect(
        candidateIds(await feed(db, 'neighborhood', eve.as, { areaId: mission })),
      ).not.toContain(root.post.id)
      expect(await errorCode(db.rpc('post_replies', { post_id: root.post.id }, eve.as))).toBe(
        'post_not_found',
      )
      expect((await rawSearch(eve.as, secret)).posts).toEqual([])
    })

    it('a reply in a city thread stays inside the city', async () => {
      const root = await createPost(db, ann, { text: `${secret} city`, audience: 'city' })
      expect(root.post.areaId).toBe(sf)
      const reply = await createPost(db, bea, {
        text: `${secret} city reply`,
        audience: 'world',
        parentPostId: root.post.id,
      })
      expect(reply.post).toMatchObject({ audience: 'city', areaId: sf })
      expect(await canSee(db, reply.post.id, eve.as)).toBe(true)
      const angeleno = await human(db, 'Angeleno')
      await setContext(db, angeleno, { currentCityId: la, homeCityId: la })
      expect(await canSee(db, reply.post.id, angeleno.as)).toBe(false)
      expect(await canSee(db, reply.post.id, 'visitor')).toBe(false)
      expect(await rlsCounts(angeleno.as, reply.post.id)).toEqual({
        posts: 0,
        post_media: 0,
        post_reactions: 0,
      })
    })

    it('a reply in a world thread reaches visitors; when the root is removed the replies leave distribution for everyone but their authors', async () => {
      const root = await createPost(db, ann, { text: `${secret} world`, audience: 'world' })
      const reply = await createPost(db, bea, {
        text: `${secret} world reply`,
        audience: 'world',
        parentPostId: root.post.id,
      })
      expect(reply.post.audience).toBe('world')
      expect(await canSee(db, reply.post.id, 'visitor')).toBe(true)
      expect(await canSee(db, reply.post.id, eve.as)).toBe(true)
      expect(await rlsCounts('visitor', reply.post.id)).toEqual({
        posts: 1,
        post_media: 0,
        post_reactions: 0,
      })
      await db.rpc('post_delete', { post_id: root.post.id }, ann.as)
      for (const viewer of [eve.as, dan.as, 'visitor' as const, guest]) {
        expect(await canSee(db, reply.post.id, viewer)).toBe(false)
        expect(await rlsCounts(viewer, reply.post.id)).toEqual({
          posts: 0,
          post_media: 0,
          post_reactions: 0,
        })
      }
      expect((await rawSearch(eve.as, `${secret} world reply`)).text).not.toContain(reply.post.id)
      expect(await canSee(db, reply.post.id, bea.as)).toBe(true)
      // Nobody can continue the thread of a removed root.
      expect(
        await errorCode(
          db.rpc('post_create', postArgs({ text: 'late', parentPostId: reply.post.id }), dan.as),
        ),
      ).toBe('post_not_found')
    })

    it('no reshare path exists and no stored reply is wider than its root', async () => {
      const { rows: args } = await db.sql.query<{ names: string[] }>(
        `select p.proargnames as names from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'post_create'`,
      )
      expect(args).toHaveLength(1)
      expect(args[0]?.names.some((name) => name.includes('reshare_of'))).toBe(false)
      expect(
        Number(
          (
            await db.sql.query<{ n: string }>(
              `select count(*)::text as n from public.posts where reshare_of_post_id is not null`,
            )
          ).rows[0]?.n,
        ),
      ).toBe(0)
      const { rows: wider } = await db.sql.query(
        `select r.id from public.posts r join public.posts root on root.id = r.root_post_id
          where r.audience > root.audience or root.parent_post_id is not null`,
      )
      expect(wider).toEqual([])
      expect(
        Number(
          (
            await db.sql.query<{ n: string }>(
              `select count(*)::text as n from public.posts where parent_post_id is not null`,
            )
          ).rows[0]?.n,
        ),
      ).toBeGreaterThan(3)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('private group / chat content never appears in World (spec §128)', () => {
    let gus: Human
    let hal: Human
    let ivy: Human
    let jo: Human
    let sid: Human
    let guest: RoleSpec
    let claiming: RoleSpec
    let crew: { groupId: string; conversationId: string }
    let dm: string
    let groupRoomId: string
    let directRoomId: string
    let worldPostId: string
    let nbPostId: string
    const secrets = {
      groupMessage: `groupmsg-${tag}`,
      dmMessage: `dmmsg-${tag}`,
      friendsPost: `friendspost-${tag}`,
      nbPost: `nbpost-${tag}`,
      cityPost: `citypost-${tag}`,
    }

    beforeAll(async () => {
      gus = await human(db, 'Gus')
      hal = await human(db, 'Hal')
      ivy = await human(db, `Ivy${tag}`)
      jo = await human(db, 'Jo')
      sid = await human(db, 'Sid')
      await befriend(db, gus, jo)
      await setContext(db, gus, { currentAreaId: mission, currentCityId: sf })
      await setContext(db, sid, { currentAreaId: mission, currentCityId: sf })
      guest = (await createGuest(db)).as
      claiming = (await createHuman(db, { handle: `claimw${tag}`, status: 'pending' })).as
      crew = await createGroup(db, gus, `Crew ${tag}`)
      await addMember(db, crew, hal)
      await sendMessage(db, gus, crew.conversationId, secrets.groupMessage)
      dm = await directConversation(db, gus, ivy)
      await sendMessage(db, gus, dm, secrets.dmMessage)
      await createPost(db, gus, {
        text: secrets.friendsPost,
        audience: 'friends',
        placeId: doloresPark,
      })
      nbPostId = (
        await createPost(db, gus, {
          text: secrets.nbPost,
          audience: 'neighborhood',
          placeId: doloresPark,
        })
      ).post.id
      await createPost(db, gus, { text: secrets.cityPost, audience: 'city', placeId: doloresPark })
      worldPostId = (await createPost(db, gus, { text: `worldpost-${tag}`, audience: 'world' }))
        .post.id
      groupRoomId = (await startGroupRoom(db, gus, crew, `Crew night ${tag}`)).room.id
      directRoomId = (
        await db.rpc<{ room: { id: string } }>(
          'room_start',
          { context_type: 'direct', context_id: dm, title: null },
          gus.as,
        )
      ).room.id
    })

    afterAll(async () => {
      await endRoom(db, groupRoomId, gus)
      await endRoom(db, directRoomId, gus)
    })

    function expectNoPrivateContent(text: string): void {
      for (const value of Object.values(secrets)) expect(text).not.toContain(value)
      expect(text).not.toContain(crew.conversationId)
      expect(text).not.toContain(dm)
      expect(text).not.toContain(groupRoomId)
      expect(text).not.toContain(directRoomId)
    }

    it('World feeds, the public feed, the World map and search carry world posts and world Lives only, for every caller kind', async () => {
      const callers: Array<[string, RoleSpec]> = [
        ['visitor', 'visitor'],
        ['guest', guest],
        ['claiming', claiming],
        ['stranger in the same neighborhood', sid.as],
        ['group member', hal.as],
        ['service', 'service'],
      ]
      for (const [label, as] of callers) {
        const parsed = await feed(db, 'world', as)
        expect(candidateIds(parsed), label).toContain(worldPostId)
        for (const row of parsed.candidates) {
          if (row.kind === 'post') {
            expect(row.audience, label).toBe('world')
            expect(row.post?.post.parentPostId, label).toBeNull()
            expect(row.post?.post.audience, label).toBe('world')
          } else {
            expect(row.live?.visibility, label).toBe('world')
          }
        }
        expectNoPrivateContent(
          JSON.stringify(await db.rpc('feed_candidates', { scope: 'world' }, as)),
        )
        expectNoPrivateContent(
          JSON.stringify(await db.rpc('public_feed', { cursor: null, limit: 100 }, as)),
        )
        if (label !== 'guest') {
          const map = await db.rpc<{
            moments: Array<{ postId: string }>
            lives: Array<{ roomId: string }>
          }>(
            'map_objects',
            {
              scope: 'world',
              min_lat: SF_BBOX.minLat,
              min_lng: SF_BBOX.minLng,
              max_lat: SF_BBOX.maxLat,
              max_lng: SF_BBOX.maxLng,
            },
            as,
          )
          expectNoPrivateContent(JSON.stringify(map))
          expect(
            map.moments.map((m) => m.postId),
            label,
          ).not.toContain(nbPostId)
        }
      }
      // The stranger and the member can read the neighborhood post where it belongs (World is the
      // scope that excludes it, not their permissions) — and search never surfaces private text.
      expect(candidateIds(await feed(db, 'neighborhood', sid.as))).toContain(nbPostId)
      expect(
        (await mapObjects(db, 'neighborhood', MISSION_BBOX, sid.as)).moments.map((m) => m.postId),
      ).toContain(nbPostId)
      // Search never surfaces a message to anyone, nor a post beyond its audience: the member (no
      // context, not a friend), visitors, Guests and claiming Humans see none of them; the
      // stranger in the Mission reads the neighborhood post where it belongs, never the friends post.
      for (const value of [secrets.groupMessage, secrets.dmMessage]) {
        for (const as of [sid.as, hal.as, jo.as, gus.as, ivy.as, 'visitor' as const]) {
          expect((await rawSearch(as, value)).text, value).not.toContain(value)
        }
      }
      for (const value of [secrets.friendsPost, secrets.nbPost, secrets.cityPost]) {
        for (const as of [hal.as, 'visitor' as const, guest, claiming]) {
          expect((await rawSearch(as, value)).text, value).not.toContain(value)
        }
      }
      expect((await rawSearch(sid.as, secrets.friendsPost)).text).not.toContain(secrets.friendsPost)
      expect((await rawSearch(sid.as, secrets.nbPost)).text).toContain(secrets.nbPost)
      // Group membership puts the group Live in the member's Friends scope, never in World.
      expect(candidateIds(await feed(db, 'friends', hal.as))).toContain(groupRoomId)
      expect(candidateIds(await feed(db, 'world', hal.as))).not.toContain(groupRoomId)
      expect(candidateIds(await feed(db, 'world', gus.as))).not.toContain(groupRoomId)
      expect(candidateIds(await feed(db, 'world', gus.as))).not.toContain(directRoomId)
    })

    it('opening a direct room to World never names the other member of the chat, who only holds an invited seat', async () => {
      await openUp(db, directRoomId, gus, 'world')
      const box = SF_BBOX
      const viewers: Array<[string, RoleSpec]> = [
        ['visitor', 'visitor'],
        ['stranger', sid.as],
        ["the host's friend", jo.as],
        ['service', 'service'],
      ]
      for (const [label, as] of viewers) {
        const worldFeed = await db.rpc<{ candidates: Array<{ id: string }> }>(
          'feed_candidates',
          { scope: 'world' },
          as,
        )
        const liveRow = worldFeed.candidates.find((c) => c.id === directRoomId)
        expect(liveRow, label).toBeDefined()
        expect(JSON.stringify(liveRow), label).not.toContain(ivy.displayName)
        expect(JSON.stringify(liveRow), label).not.toContain(ivy.humanId)
        expect(JSON.stringify(liveRow), label).not.toContain(secrets.dmMessage)
        const lives = await db.rpc<{ candidates: Array<{ roomId: string }> }>(
          'live_candidates',
          { scope: 'world', area_id: null },
          as,
        )
        const item = lives.candidates.find((c) => c.roomId === directRoomId)
        expect(item, label).toBeDefined()
        expect(JSON.stringify(item), label).not.toContain(ivy.displayName)
        expect(JSON.stringify(item), label).not.toContain(ivy.humanId)
        const room = await db.rpc<{ participants: Array<{ humanId: string | null }> }>(
          'room_get',
          { room_id: directRoomId },
          as,
        )
        expect(
          room.participants.map((p) => p.humanId),
          label,
        ).toEqual([gus.humanId])
        expect(JSON.stringify(room), label).not.toContain(ivy.displayName)
        expect(JSON.stringify(room), label).not.toContain(ivy.humanId)
        const map = await db.rpc<{ lives: Array<{ roomId: string; title: string }> }>(
          'map_objects',
          {
            scope: 'world',
            min_lat: box.minLat,
            min_lng: box.minLng,
            max_lat: box.maxLat,
            max_lng: box.maxLng,
          },
          as,
        )
        const pin = map.lives.find((l) => l.roomId === directRoomId)
        expect(pin, label).toBeDefined()
        expect(pin?.title, label).not.toContain(ivy.displayName)
      }
      // Jo's Friends scope (friend of the publisher) tells the same story.
      const friendsFeed = await db.rpc<{ candidates: Array<{ id: string }> }>(
        'feed_candidates',
        { scope: 'friends' },
        jo.as,
      )
      const forJo = friendsFeed.candidates.find((c) => c.id === directRoomId)
      expect(forJo).toBeDefined()
      expect(JSON.stringify(forJo)).not.toContain(ivy.displayName)
      // A link preview seen by anyone with the link says as much and no more.
      const invite = await createRoomInvite(db, directRoomId, gus)
      const preview = await db.rpc('room_invite_preview', { token: invite.token }, 'visitor')
      expect(JSON.stringify(preview)).not.toContain(ivy.displayName)
      // The members of the chat keep their context.
      expect((await getRoom(db, directRoomId, gus.as)).contextTitle).toBe(ivy.displayName)
      expect((await getRoom(db, directRoomId, ivy.as)).contextTitle).toBe(gus.displayName)
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('exact location is never inferred as permission (spec §74–§76, §128)', () => {
    let kim: Human
    let lee: Human
    let mo: Human
    let sid: Human
    let roomId: string

    beforeAll(async () => {
      kim = await human(db, 'Kim')
      lee = await human(db, 'Lee')
      mo = await human(db, 'Mo')
      sid = await human(db, 'Sidney')
      await befriend(db, kim, lee)
      await befriend(db, kim, mo)
      // Kim's context comes from a device position through the RPC; the others declare areas.
      await db.rpc(
        'context_resolve_and_set',
        { lat: POINTS.northBeachProbe.lat, lng: POINTS.northBeachProbe.lng },
        kim.as,
      )
      await setContext(db, lee, { currentAreaId: northBeach, currentCityId: sf })
      await setContext(db, mo, { currentAreaId: northBeach, currentCityId: sf })
      await setContext(db, sid, { currentAreaId: northBeach, currentCityId: sf })
      await createShare(db, kim, {
        audienceId: lee.humanId,
        precision: 'precise',
        position: POINTS.northBeach,
      })
      roomId = (await startStandaloneRoom(db, kim, `Kitchen ${tag}`)).room.id
      await openUp(db, roomId, kim, 'world')
    })

    afterAll(async () => {
      await endRoom(db, roomId, kim)
    })

    it('a World Live is pinned at its area centroid for everyone, including the friend who holds the host’s precise share', async () => {
      for (const [label, as] of [
        ['audience of the share', lee.as],
        ['other friend', mo.as],
        ['stranger', sid.as],
        ['visitor', 'visitor'],
      ] as Array<[string, RoleSpec]>) {
        const map = await mapObjects(db, 'world', SF_BBOX, as)
        const pin = map.lives.find((l) => l.roomId === roomId)
        expect(pin, label).toMatchObject({
          lat: SF_CENTROID.lat,
          lng: SF_CENTROID.lng,
          precision: 'city',
        })
        if (as === lee.as) {
          expect(map.friends).toEqual([
            expect.objectContaining({
              humanId: kim.humanId,
              lat: POINTS.northBeach.lat,
              lng: POINTS.northBeach.lng,
              precision: 'precise',
            }),
          ])
        } else {
          expect(map.friends, label).toEqual([])
        }
      }
      expect(await visibleShares(db, mo.as)).toEqual([])
      expect(await visibleShares(db, sid.as)).toEqual([])
      const worldFeed = await feed(db, 'world', lee.as)
      const row = worldFeed.candidates.find((c) => c.id === roomId)
      expect(row).toMatchObject({ kind: 'live', areaId: sf })
      expect(coordinatePaths(await db.rpc('feed_candidates', { scope: 'world' }, lee.as))).toEqual(
        [],
      )
      expect(
        coordinatePaths(await db.rpc('live_candidates', { scope: 'world', area_id: null }, lee.as)),
      ).toEqual([])
      expect(coordinatePaths(await db.rpc('room_get', { room_id: roomId }, lee.as))).toEqual([])
    })

    it('post and feed payloads carry areas and explicit Places only; a post without a Place is never on the map', async () => {
      const nb = await createPost(db, kim, { text: `nb-${tag}`, audience: 'neighborhood' })
      expect(nb.post.areaId).toBe(northBeach)
      expect(coordinatePaths(nb)).toEqual([])
      // The context never leaks into audiences that do not use it.
      expect(
        (await createPost(db, kim, { text: `friends-${tag}`, audience: 'friends' })).post.areaId,
      ).toBeNull()
      expect(
        (await createPost(db, kim, { text: `world-${tag}`, audience: 'world' })).post.areaId,
      ).toBeNull()
      const moment = await createPost(db, kim, {
        type: 'moment',
        text: `moment-${tag}`,
        audience: 'neighborhood',
        placeId: washingtonSquare,
      })
      expect(coordinatePaths(moment)).toEqual(['place.lat', 'place.lng'])
      const raw = await db.rpc('feed_candidates', { scope: 'neighborhood' }, sid.as)
      const paths = coordinatePaths(raw)
      expect(paths.length).toBeGreaterThan(0)
      for (const path of paths) expect(path).toMatch(PLACE_ONLY)
      const parsed = await feed(db, 'neighborhood', sid.as)
      expect(candidateIds(parsed)).toEqual(expect.arrayContaining([nb.post.id, moment.post.id]))
      const map = await mapObjects(db, 'neighborhood', NORTH_BEACH_BBOX, sid.as)
      expect(map.moments.map((m) => m.postId)).not.toContain(nb.post.id)
      expect(map.moments.find((m) => m.postId === moment.post.id)).toMatchObject({
        lat: WASHINGTON_SQUARE.lat,
        lng: WASHINGTON_SQUARE.lng,
      })
      for (const as of [lee.as, 'visitor' as const]) {
        expect(
          coordinatePaths(await db.rpc('posts_by_author', { handle: kim.handle }, as)).every((p) =>
            PLACE_ONLY.test(p),
          ),
        ).toBe(true)
      }
    })

    it('reads never store the coordinates they are given (map box, resolved positions)', async () => {
      const before = await coordinateDigest(db)
      const box: Bbox = {
        minLat: 37.70123,
        minLng: -122.51234,
        maxLat: 37.83456,
        maxLng: -122.36789,
      }
      for (const scope of ['friends', 'neighborhood', 'city', 'world'])
        await mapObjects(db, scope, box, lee.as)
      await mapObjects(db, 'world', box, 'visitor')
      await db.rpc('area_resolve', { lat: POINTS.parkProbe.lat, lng: POINTS.parkProbe.lng }, lee.as)
      await db.rpc(
        'context_resolve_and_set',
        { lat: POINTS.parkProbe.lat, lng: POINTS.parkProbe.lng },
        mo.as,
      )
      await feed(db, 'neighborhood', lee.as)
      await db.rpc('live_candidates', { scope: 'city', area_id: null }, lee.as)
      expect(await coordinateDigest(db)).toEqual(before)
      expect(
        await tablesMentioning(db, [
          '37.70123',
          '122.51234',
          '37.83456',
          '122.36789',
          '37.77123',
          '122.49234',
        ]),
      ).toEqual([])
    })

    it('a Human’s area context is theirs alone', async () => {
      const mine = await db.asRole(kim.as, (c) =>
        c.query('select current_area_id from public.human_context where human_id = $1', [
          kim.humanId,
        ]),
      )
      expect(mine.rows).toEqual([{ current_area_id: northBeach }])
      const theirs = await db.asRole(lee.as, (c) =>
        c.query('select current_area_id from public.human_context where human_id = $1', [
          kim.humanId,
        ]),
      )
      expect(theirs.rows).toEqual([])
      const forged = await db.asRole(lee.as, (c) =>
        c.query('update public.human_context set current_area_id = $2 where human_id = $1', [
          kim.humanId,
          mission,
        ]),
      )
      expect(forged.rowCount).toBe(0)
      const profile = JSON.stringify(await db.rpc('profile_get', { handle: kim.handle }, lee.as))
      expect(profile).not.toContain('North Beach')
      expect(profile).not.toContain(northBeach)
      expect(
        JSON.stringify(await db.rpc('search', { q: kim.displayName, limit: 10 }, sid.as)),
      ).not.toContain('North Beach')
    })
  })

  // -------------------------------------------------------------------------------------------
  describe('audience permission is server-authoritative (spec §71, §128)', () => {
    let ned: Human
    let ola: Human
    let nocontext: Human
    let nbPostId: string

    beforeAll(async () => {
      ned = await human(db, 'Ned')
      ola = await human(db, 'Ola')
      nocontext = await human(db, 'Nocontext')
      await befriend(db, ned, ola)
      await setContext(db, ned, { currentAreaId: mission, currentCityId: sf })
      await setContext(db, ola, { currentAreaId: marina, currentCityId: sf })
      nbPostId = (
        await createPost(db, ned, {
          text: `ned-nb-${tag}`,
          audience: 'neighborhood',
          placeId: doloresPark,
        })
      ).post.id
    })

    it('clients hold no write privilege on post, reaction, hide or location rows, and no read on raw positions', async () => {
      const tables = [
        'posts',
        'post_media',
        'post_reactions',
        'post_hides',
        'location_shares',
        'location_share_positions',
      ]
      for (const role of ['anon', 'authenticated']) {
        for (const table of tables) {
          for (const privilege of ['insert', 'update', 'delete']) {
            const { rows } = await db.sql.query<{ ok: boolean }>(
              `select has_table_privilege($1, $2, $3) as ok`,
              [role, `public.${table}`, privilege],
            )
            expect(rows[0]?.ok, `${role} ${privilege} ${table}`).toBe(false)
          }
        }
        const { rows } = await db.sql.query<{ ok: boolean }>(
          `select has_table_privilege($1, 'public.location_share_positions', 'select') as ok`,
          [role],
        )
        expect(rows[0]?.ok, `${role} select location_share_positions`).toBe(false)
      }
      const attempts: Array<[string, RoleSpec, string, unknown[]]> = [
        [
          'insert a world post',
          ned.as,
          `insert into public.posts (author_human_id, type, text, audience) values ($1, 'text', 'forged', 'world')`,
          [ned.humanId],
        ],
        [
          'widen own post',
          ned.as,
          `update public.posts set audience = 'world' where id = $1`,
          [nbPostId],
        ],
        [
          'forge a reaction',
          ola.as,
          `insert into public.post_reactions (post_id, human_id, reaction_type) values ($1, $2, 'heart')`,
          [nbPostId, ola.humanId],
        ],
        [
          'forge a hide',
          ola.as,
          `insert into public.post_hides (human_id, post_id) values ($1, $2)`,
          [ola.humanId, nbPostId],
        ],
        [
          'forge a share',
          ned.as,
          `insert into public.location_shares (human_id, audience_type, audience_id, precision, expires_at) values ($1, 'friend', $2, 'precise', now() + interval '1 hour')`,
          [ned.humanId, ola.humanId],
        ],
        [
          'forge a position',
          ned.as,
          `insert into public.location_share_positions (share_id, location) values (gen_random_uuid(), st_setsrid(st_makepoint(0, 0), 4326))`,
          [],
        ],
        ['read raw positions', ola.as, `select share_id from public.location_share_positions`, []],
      ]
      for (const [label, as, sql, values] of attempts) {
        let denied = false
        try {
          await db.asRole(as, (c) => c.query(sql, values))
        } catch (error) {
          denied = isPermissionDenied(error)
          if (!denied) throw error
        }
        expect(denied, label).toBe(true)
      }
    })

    it('browsing an area never widens: neighborhood posts stay gated by the viewer’s own context on the feed and on the map', async () => {
      expect(candidateIds(await feed(db, 'neighborhood', ned.as))).toContain(nbPostId)
      // Ola (a friend) sees it anywhere; a stranger in the Marina browsing the Mission does not.
      const stranger = await human(db, 'Marinastranger')
      await setContext(db, stranger, { currentAreaId: marina, currentCityId: sf })
      expect(
        candidateIds(await feed(db, 'neighborhood', stranger.as, { areaId: mission })),
      ).not.toContain(nbPostId)
      expect(candidateIds(await feed(db, 'city', stranger.as, { areaId: sf }))).not.toContain(
        nbPostId,
      )
      expect(await canSee(db, nbPostId, stranger.as)).toBe(false)
      // A Human without any context browsing the Mission box: the box picks the area, not the permission.
      const map = await mapObjects(db, 'neighborhood', MISSION_BBOX, nocontext.as)
      expect(map.moments.map((m) => m.postId)).not.toContain(nbPostId)
      expect(
        candidateIds(await feed(db, 'neighborhood', nocontext.as, { areaId: mission })),
      ).not.toContain(nbPostId)
      // Someone in the Mission sees it on both surfaces (the gate is the context, not the box).
      const local = await human(db, 'Missionlocal')
      await setContext(db, local, { currentAreaId: mission, currentCityId: sf })
      expect(
        (await mapObjects(db, 'neighborhood', MISSION_BBOX, local.as)).moments.map((m) => m.postId),
      ).toContain(nbPostId)
      expect(candidateIds(await feed(db, 'neighborhood', local.as))).toContain(nbPostId)
    })
  })
})
