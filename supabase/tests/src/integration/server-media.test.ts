/**
 * `GET /api/media/:bucket/:key*` end to end (spec §104 "signed access for private media";
 * ARCHITECTURE §5, §6): the URL `earth.media_url()` puts in every `PostMediaDto` is answered by
 * the route, which authorizes the caller with the real `media_access_grant` before the service
 * role signs the object. A recipient of the post is redirected; anyone outside the audience — a
 * stranger, a blocked ex-friend, a Visitor — is refused and nothing is signed.
 */
import { PostViewDtoSchema } from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  befriend,
  block,
  createMedia,
  createPost,
  human,
  setFlag,
  type Human,
} from '../posts/fixtures'
import {
  createEarthServer,
  createServerTestDeps,
  errorCodeOf,
  fakeRequest,
  type EarthResponse,
  type EarthServer,
  type ServerTestDeps,
} from './server-deps'

const MEDIA_BUCKET = 'media'

describe('GET /api/media/:bucket/:key* (server tier ↔ media_access_grant)', () => {
  let db: TestDb
  let ctx: ServerTestDeps
  let server: EarthServer
  let author: Human
  let friend: Human
  let stranger: Human
  let blocked: Human
  let friendsKey: string
  let worldKey: string

  /** The route as a client reaches it: the media URL of the post DTO, with the caller's bearer. */
  async function fetchMedia(key: string, as: RoleSpec | null): Promise<EarthResponse> {
    const url = `/api/media/${MEDIA_BUCKET}/${key}`
    return server.handle(
      as === null ? fakeRequest({ url }) : fakeRequest({ url, bearer: ctx.tokens.for(as) }),
    )
  }

  beforeAll(async () => {
    db = await createTestDb()
    ctx = createServerTestDeps(db)
    server = createEarthServer(ctx.deps)
    await setFlag(db, 'PUBLIC_WORLD_ENABLED', true)
    author = await human(db, 'Author')
    friend = await human(db, 'Friend')
    stranger = await human(db, 'Stranger')
    blocked = await human(db, 'Blocked')
    await befriend(db, author, friend)
    await befriend(db, author, blocked)
    await block(db, author, blocked)

    const friendsMedia = await createMedia(db, author, { key: `${author.humanId}/friends.jpg` })
    const worldMedia = await createMedia(db, author, { key: `${author.humanId}/world.jpg` })
    const friendsPost = await createPost(db, author, {
      type: 'image',
      audience: 'friends',
      media: [friendsMedia],
    })
    const worldPost = await createPost(db, author, {
      type: 'image',
      audience: 'world',
      media: [worldMedia],
    })
    friendsKey = `${author.humanId}/friends.jpg`
    worldKey = `${author.humanId}/world.jpg`

    // The DTO both clients render points at this very route (0410 earth.media_url).
    const view = PostViewDtoSchema.parse(friendsPost)
    expect(view.media[0]?.url).toMatch(
      new RegExp(`/api/media/${MEDIA_BUCKET}/${friendsKey}$`.replace(/\./g, '\\.')),
    )
    expect(PostViewDtoSchema.parse(worldPost).media).toHaveLength(1)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('redirects a recipient to a short-lived signed URL', async () => {
    const before = ctx.storage.calls.length
    const res = await fetchMedia(friendsKey, friend.as)

    expect(res.status).toBe(302)
    expect(res.headers['location']).toContain(`/${MEDIA_BUCKET}/${friendsKey}`)
    expect(res.headers['cache-control']).toContain('private')
    const signed = ctx.storage.calls.slice(before)
    expect(signed).toHaveLength(1)
    expect(signed[0]?.bucket).toBe(MEDIA_BUCKET)
    expect(signed[0]?.path).toBe(friendsKey)
    expect(signed[0]?.expiresIn).toBeGreaterThan(0)
  })

  it('redirects the owner', async () => {
    expect((await fetchMedia(friendsKey, author.as)).status).toBe(302)
  })

  it('refuses everyone outside the audience and signs nothing', async () => {
    const before = ctx.storage.calls.length
    for (const [who, as] of [
      ['stranger', stranger.as],
      ['blocked', blocked.as],
      ['visitor', null],
    ] as const) {
      const res = await fetchMedia(friendsKey, as)
      expect(res.status, who).toBe(403)
      expect(errorCodeOf(res), who).toBe('forbidden')
    }
    expect(ctx.storage.calls.slice(before)).toEqual([])
  })

  it('refuses an object no post or message carries, and an unknown key', async () => {
    const orphan = `${author.humanId}/orphan.jpg`
    await createMedia(db, author, { key: orphan })
    expect((await fetchMedia(orphan, stranger.as)).status).toBe(403)
    // The owner still reads their own upload (compose previews it before the post exists).
    expect((await fetchMedia(orphan, author.as)).status).toBe(302)
    expect((await fetchMedia(`${author.humanId}/nothing-here.jpg`, friend.as)).status).toBe(403)
  })

  it('lets a Visitor read world post media', async () => {
    const res = await fetchMedia(worldKey, null)
    expect(res.status).toBe(302)
    expect(res.headers['location']).toContain(worldKey)
  })
})
