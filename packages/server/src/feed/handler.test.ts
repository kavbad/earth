import {
  FEED_PAGE_SIZE,
  FeedPageDtoSchema,
  LiveListDtoSchema,
  decodeCursor,
  encodeCursor,
} from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  FEED_CANDIDATES_RPC,
  FEED_CANDIDATE_LIMIT,
  FEED_LOG,
  LIVE_CANDIDATE_LIMIT,
  handleFeed,
  handleLive,
} from './handler'
import { FEED_PRESENCE_RPC } from './presence'
import { FakeRpcFailure, TEST_NOW, createFakeDeps, fakeRequest, rpcFailure } from '../test/fakes'
import {
  liveRoom,
  liveRow,
  participant,
  postRow,
  postView,
  presenceGroup,
  presenceNearbyFriend,
  presenceResult,
} from '../test/fixtures'

function candidates(postCount: number, liveCount = 0): Record<string, unknown>[] {
  const posts = Array.from({ length: postCount }, (_, i) => postRow(i + 1))
  const lives = Array.from({ length: liveCount }, (_, i) => liveRow(100 + i))
  return [...lives, ...posts]
}

describe('handleFeed', () => {
  it('lets visitors read World only', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { feed_candidates: () => candidates(3) } })
    const res = await handleFeed(deps, fakeRequest({ url: '/api/feed' }))
    expect(res.status).toBe(200)
    const page = FeedPageDtoSchema.parse(res.body)
    expect(page.scope).toBe('world')
    expect(page.cards).toHaveLength(3)
    expect(supabase.calls[0]).toMatchObject({
      client: 'anon',
      name: 'feed_candidates',
      args: { scope: 'world', area_id: null, limit: FEED_CANDIDATE_LIMIT },
    })

    for (const scope of ['friends', 'neighborhood', 'city']) {
      await expect(
        handleFeed(deps, fakeRequest({ url: `/api/feed?scope=${scope}` })),
      ).rejects.toMatchObject({ code: 'not_authenticated' })
    }
    expect(supabase.calls).toHaveLength(1)
  })

  it('runs as the caller with a bearer and passes area and snapshot', async () => {
    const { deps, supabase } = createFakeDeps({
      rpc: { feed_candidates: () => ({ candidates: candidates(2), areaName: 'Mission' }) },
    })
    const area = '99999999-9999-4999-8999-999999999999'
    const res = await handleFeed(
      deps,
      fakeRequest({ url: `/api/feed?scope=neighborhood&area=${area}`, bearer: 'jwt' }),
    )
    const page = FeedPageDtoSchema.parse(res.body)
    expect(page.areaName).toBe('Mission')
    expect(page.snapshotAt).toBe(TEST_NOW.toISOString())
    expect(supabase.calls[0]).toEqual({
      client: 'user:jwt',
      name: 'feed_candidates',
      args: {
        scope: 'neighborhood',
        area_id: area,
        snapshot_at: TEST_NOW.toISOString(),
        limit: FEED_CANDIDATE_LIMIT,
      },
    })
  })

  it('rejects an unknown scope, a bad area and a malformed cursor with invalid_input', async () => {
    const { deps } = createFakeDeps({ rpc: { feed_candidates: () => [] } })
    await expect(
      handleFeed(deps, fakeRequest({ url: '/api/feed?scope=galaxy' })),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      handleFeed(deps, fakeRequest({ url: '/api/feed?area=nope' })),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      handleFeed(deps, fakeRequest({ url: '/api/feed?cursor=!!!' })),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const wrongScope = encodeCursor({
      snapshotAt: TEST_NOW.toISOString(),
      lastScore: 0.5,
      lastId: 'x',
      scope: 'friends',
      areaId: null,
    })
    await expect(
      handleFeed(deps, fakeRequest({ url: `/api/feed?scope=world&cursor=${wrongScope}` })),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('paginates with a stable snapshot: Lives on page 1 only, no repeats, no gaps', async () => {
    const all = candidates(45, 2)
    const { deps, supabase, clock } = createFakeDeps({ rpc: { feed_candidates: () => all } })
    const first = FeedPageDtoSchema.parse(
      (await handleFeed(deps, fakeRequest({ url: '/api/feed?scope=friends', bearer: 'jwt' }))).body,
    )
    expect(first.cards).toHaveLength(FEED_PAGE_SIZE)
    expect(first.cards.filter((c) => c.kind === 'live')).toHaveLength(2)
    expect(first.nextCursor).not.toBeNull()
    expect(decodeCursor(first.nextCursor ?? '', { scope: 'friends' }).snapshotAt).toBe(
      first.snapshotAt,
    )

    // Time moves on; the cursor pins the snapshot so scores (and the candidate query) repeat.
    clock.now = new Date(TEST_NOW.getTime() + 60 * 60 * 1000)
    const second = FeedPageDtoSchema.parse(
      (
        await handleFeed(
          deps,
          fakeRequest({
            url: `/api/feed?scope=friends&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
            bearer: 'jwt',
          }),
        )
      ).body,
    )
    expect(second.snapshotAt).toBe(first.snapshotAt)
    expect(supabase.callsTo(FEED_CANDIDATES_RPC)[1]?.args['snapshot_at']).toBe(first.snapshotAt)
    expect(second.cards.every((c) => c.kind === 'post')).toBe(true)
    expect(second.cards).toHaveLength(FEED_PAGE_SIZE)

    const third = FeedPageDtoSchema.parse(
      (
        await handleFeed(
          deps,
          fakeRequest({
            url: `/api/feed?scope=friends&cursor=${encodeURIComponent(second.nextCursor ?? '')}`,
            bearer: 'jwt',
          }),
        )
      ).body,
    )
    expect(third.nextCursor).toBeNull()
    const ids = [...first.cards, ...second.cards, ...third.cards].map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.filter((id) => !id.startsWith('20000000'))).toHaveLength(45)
  })

  it('renders Live cards with viewer-aware titles from participant relations', async () => {
    const row = liveRow(7, {
      participants: [
        participant(1, { displayName: 'Ben', relationToViewer: 'other' }),
        participant(2, { displayName: 'Xavier', relationToViewer: 'friend' }),
      ],
    })
    const { deps } = createFakeDeps({ rpc: { feed_candidates: () => [row, postRow(1)] } })
    const page = FeedPageDtoSchema.parse(
      (await handleFeed(deps, fakeRequest({ url: '/api/feed?scope=friends', bearer: 'jwt' }))).body,
    )
    const live = page.cards.find((c) => c.kind === 'live')
    expect(live).toMatchObject({
      kind: 'live',
      title: 'Xavier + Ben are live',
      participantNames: ['Xavier', 'Ben'],
    })
  })

  it('prepends the SCREEN 02 presence row: friends live, active groups, friends nearby', async () => {
    const { deps, supabase } = createFakeDeps({
      rpc: {
        feed_candidates: () => candidates(3),
        feed_presence: () =>
          presenceResult({
            liveRooms: [
              liveRoom(50, {
                participants: [
                  participant(1, { displayName: 'Xavier', relationToViewer: 'friend' }),
                  participant(2, { displayName: 'Maya', relationToViewer: 'friend' }),
                ],
                participantCount: 2,
              }),
            ],
            activeGroups: [presenceGroup(3)],
            nearbyFriends: [presenceNearbyFriend(4)],
          }),
      },
    })
    const page = FeedPageDtoSchema.parse(
      (await handleFeed(deps, fakeRequest({ url: '/api/feed?scope=friends', bearer: 'jwt' }))).body,
    )
    const first = page.cards[0]
    expect(first?.kind).toBe('presence')
    expect(first?.kind === 'presence' ? first.items.map((item) => item.label) : []).toEqual([
      'Xavier + Maya live',
      'Weekend Crew · 3 active',
      'Sarah nearby',
    ])
    expect(page.cards.filter((card) => card.kind === 'presence')).toHaveLength(1)
    expect(page.cards.slice(1).every((card) => card.kind === 'post')).toBe(true)
    expect(supabase.callsTo(FEED_PRESENCE_RPC)[0]).toEqual({
      client: 'user:jwt',
      name: FEED_PRESENCE_RPC,
      args: {},
    })
  })

  it('shows no presence row without meaningful state, for visitors, or on later pages', async () => {
    const empty = createFakeDeps({
      rpc: { feed_candidates: () => candidates(3), feed_presence: () => presenceResult() },
    })
    const page = FeedPageDtoSchema.parse(
      (await handleFeed(empty.deps, fakeRequest({ url: '/api/feed?scope=friends', bearer: 'jwt' })))
        .body,
    )
    expect(page.cards.some((card) => card.kind === 'presence')).toBe(false)

    // Visitors have no presence to speak of: the row is never read for them.
    const visitor = createFakeDeps({
      rpc: {
        feed_candidates: () => candidates(3),
        feed_presence: () => presenceResult({ nearbyFriends: [presenceNearbyFriend(4)] }),
      },
    })
    const visitorPage = FeedPageDtoSchema.parse(
      (await handleFeed(visitor.deps, fakeRequest({ url: '/api/feed' }))).body,
    )
    expect(visitorPage.cards.some((card) => card.kind === 'presence')).toBe(false)
    expect(visitor.supabase.callsTo(FEED_PRESENCE_RPC)).toHaveLength(0)

    // Page 2 of the same scroll: the row belongs to the top of the feed only.
    const paged = createFakeDeps({
      rpc: {
        feed_candidates: () => candidates(45),
        feed_presence: () => presenceResult({ nearbyFriends: [presenceNearbyFriend(4)] }),
      },
    })
    const firstPage = FeedPageDtoSchema.parse(
      (await handleFeed(paged.deps, fakeRequest({ url: '/api/feed?scope=friends', bearer: 'jwt' })))
        .body,
    )
    expect(firstPage.cards[0]?.kind).toBe('presence')
    const secondPage = FeedPageDtoSchema.parse(
      (
        await handleFeed(
          paged.deps,
          fakeRequest({
            url: `/api/feed?scope=friends&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
            bearer: 'jwt',
          }),
        )
      ).body,
    )
    expect(secondPage.cards.some((card) => card.kind === 'presence')).toBe(false)
    expect(paged.supabase.callsTo(FEED_PRESENCE_RPC)).toHaveLength(1)
  })

  it('serves the feed without the row when presence cannot be read', async () => {
    const { deps, logs } = createFakeDeps({
      rpc: {
        feed_candidates: () => candidates(3),
        feed_presence: () => {
          throw rpcFailure('internal')
        },
      },
    })
    const page = FeedPageDtoSchema.parse(
      (await handleFeed(deps, fakeRequest({ url: '/api/feed?scope=friends', bearer: 'jwt' }))).body,
    )
    expect(page.cards).toHaveLength(3)
    expect(page.cards.some((card) => card.kind === 'presence')).toBe(false)
    expect(logs.records.some((record) => record.msg === FEED_LOG.presenceUnavailable)).toBe(true)
  })

  it('surfaces database errors and refuses rows that violate the contract', async () => {
    const denied = createFakeDeps({
      rpc: {
        feed_candidates: () => {
          throw rpcFailure('feature_disabled')
        },
      },
    })
    await expect(handleFeed(denied.deps, fakeRequest({ url: '/api/feed' }))).rejects.toMatchObject({
      code: 'feature_disabled',
    })
    const broken = createFakeDeps({
      rpc: { feed_candidates: () => [{ ...postRow(1), post: null }] },
    })
    await expect(handleFeed(broken.deps, fakeRequest({ url: '/api/feed' }))).rejects.toMatchObject({
      code: 'internal',
    })
  })

  it('dedupes candidates by id', async () => {
    const { deps } = createFakeDeps({
      rpc: { feed_candidates: () => [postRow(1), postRow(1), postRow(2)] },
    })
    const page = FeedPageDtoSchema.parse(
      (await handleFeed(deps, fakeRequest({ url: '/api/feed' }))).body,
    )
    expect(page.cards).toHaveLength(2)
  })
})

describe('handleLive', () => {
  it('visitors may list World lives only', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { live_candidates: () => [liveRoom(1)] } })
    const res = await handleLive(deps, fakeRequest({ url: '/api/live' }))
    const list = LiveListDtoSchema.parse(res.body)
    expect(list.scope).toBe('world')
    expect(list.cards).toHaveLength(1)
    expect(supabase.calls[0]).toEqual({
      client: 'anon',
      name: 'live_candidates',
      args: { scope: 'world', area_id: null, limit: LIVE_CANDIDATE_LIMIT },
    })
    await expect(
      handleLive(deps, fakeRequest({ url: '/api/live?scope=friends' })),
    ).rejects.toMatchObject({ code: 'not_authenticated' })
  })

  it('orders friends-scope rooms per SCREEN 13 and titles them for the viewer', async () => {
    const strangers = liveRoom(1, {
      participants: [
        participant(1, { displayName: 'A' }),
        participant(2, { displayName: 'B' }),
        participant(3, { displayName: 'C' }),
      ],
    })
    const group = liveRoom(2, {
      contextType: 'group',
      contextTitle: 'Weekend Crew',
      participants: [participant(4, { relationToViewer: 'shared_group' })],
    })
    const friend = liveRoom(3, {
      participants: [participant(5, { displayName: 'Maya', relationToViewer: 'friend' })],
    })
    const { deps } = createFakeDeps({
      rpc: { live_candidates: () => ({ candidates: [strangers, group, friend], areaName: null }) },
    })
    const list = LiveListDtoSchema.parse(
      (await handleLive(deps, fakeRequest({ url: '/api/live?scope=friends', bearer: 'jwt' }))).body,
    )
    expect(list.cards.map((c) => c.title)).toEqual([
      'Maya is live',
      'Weekend Crew is live',
      'A, B + 1 are live',
    ])
  })
})

describe('adversarial: visitor gate and cursor invariants', () => {
  const AREA = '99999999-9999-4999-8999-999999999999'

  it('a garbage or expired bearer is 401, never a visitor World page nor a 500', async () => {
    const { deps, supabase } = createFakeDeps({
      rpc: {
        feed_candidates: (_args, call) => {
          if (call.client === 'user:expired') {
            throw new FakeRpcFailure({ message: 'JWT expired', code: 'PGRST301' })
          }
          return candidates(2)
        },
      },
    })
    for (const scope of ['world', 'friends']) {
      await expect(
        handleFeed(deps, fakeRequest({ url: `/api/feed?scope=${scope}`, bearer: 'expired' })),
      ).rejects.toMatchObject({ code: 'not_authenticated' })
    }
    // Never silently downgraded to the anon client.
    expect(supabase.calls.every((c) => c.client === 'user:expired')).toBe(true)
  })

  it('a non-bearer Authorization scheme is a visitor: World only', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { feed_candidates: () => candidates(1) } })
    const res = await handleFeed(
      deps,
      fakeRequest({ url: '/api/feed?scope=world', headers: { authorization: 'Basic abc' } }),
    )
    expect(res.status).toBe(200)
    expect(supabase.calls[0]?.client).toBe('anon')
    await expect(
      handleFeed(
        deps,
        fakeRequest({ url: '/api/feed?scope=friends', headers: { authorization: 'Basic abc' } }),
      ),
    ).rejects.toMatchObject({ code: 'not_authenticated' })
  })

  it('a cursor minted for another area (or no area) is refused before the database is called', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { feed_candidates: () => candidates(1) } })
    const forArea = encodeCursor({
      snapshotAt: TEST_NOW.toISOString(),
      lastScore: 0.5,
      lastId: 'x',
      scope: 'neighborhood',
      areaId: AREA,
    })
    await expect(
      handleFeed(
        deps,
        fakeRequest({ url: `/api/feed?scope=neighborhood&cursor=${forArea}`, bearer: 'jwt' }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'wrong_area' } })
    const noArea = encodeCursor({
      snapshotAt: TEST_NOW.toISOString(),
      lastScore: 0.5,
      lastId: 'x',
      scope: 'neighborhood',
      areaId: null,
    })
    await expect(
      handleFeed(
        deps,
        fakeRequest({
          url: `/api/feed?scope=neighborhood&area=${AREA}&cursor=${noArea}`,
          bearer: 'jwt',
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_input', details: { reason: 'wrong_area' } })
    expect(supabase.calls).toHaveLength(0)
  })

  it('a visitor cursor page stays pinned to the cursor snapshot and carries no Lives', async () => {
    const all = candidates(30, 3)
    const { deps, supabase, clock } = createFakeDeps({ rpc: { feed_candidates: () => all } })
    const first = FeedPageDtoSchema.parse(
      (await handleFeed(deps, fakeRequest({ url: '/api/feed?scope=world' }))).body,
    )
    expect(first.cards.filter((c) => c.kind === 'live')).toHaveLength(3)
    clock.now = new Date(TEST_NOW.getTime() + 86_400_000)
    const second = FeedPageDtoSchema.parse(
      (
        await handleFeed(
          deps,
          fakeRequest({
            url: `/api/feed?scope=world&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
          }),
        )
      ).body,
    )
    expect(second.snapshotAt).toBe(first.snapshotAt)
    expect(supabase.calls[1]).toMatchObject({
      client: 'anon',
      args: { snapshot_at: first.snapshotAt, scope: 'world' },
    })
    expect(second.cards.some((c) => c.kind === 'live')).toBe(false)
    const firstIds = new Set(first.cards.map((c) => c.id))
    expect(second.cards.every((c) => !firstIds.has(c.id))).toBe(true)
    // Page 2 continues strictly after page 1's last post in (score desc, id asc) order.
    const cursor = decodeCursor(first.nextCursor ?? '', { scope: 'world', areaId: null })
    const lastPost = [...first.cards].reverse().find((c) => c.kind === 'post')
    expect(cursor.lastId).toBe(lastPost?.id)
  })

  it('a row whose payload id disagrees with the candidate id is a contract violation (500)', async () => {
    const mismatched = { ...postRow(1), post: postView(2) }
    const { deps } = createFakeDeps({ rpc: { feed_candidates: () => [mismatched] } })
    await expect(handleFeed(deps, fakeRequest({ url: '/api/feed' }))).rejects.toMatchObject({
      code: 'internal',
    })
    const liveMismatch = { ...liveRow(5), live: liveRoom(6) }
    const live = createFakeDeps({ rpc: { feed_candidates: () => [liveMismatch] } })
    await expect(
      handleFeed(live.deps, fakeRequest({ url: '/api/feed?scope=friends', bearer: 'jwt' })),
    ).rejects.toMatchObject({ code: 'internal' })
  })

  it('card ids are unique and every card id is the candidate id (the keyset key)', async () => {
    const rows = [liveRow(50), postRow(1), postRow(2), postRow(2)]
    const { deps } = createFakeDeps({ rpc: { feed_candidates: () => rows } })
    const page = FeedPageDtoSchema.parse(
      (await handleFeed(deps, fakeRequest({ url: '/api/feed?scope=friends', bearer: 'jwt' }))).body,
    )
    const ids = page.cards.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(new Set(ids)).toEqual(new Set(rows.map((r) => r['id'] as string)))
  })
})

describe('adversarial: live discovery visitor gate', () => {
  it('an expired bearer on /api/live is 401 and never downgraded to anon', async () => {
    const { deps, supabase } = createFakeDeps({
      rpc: {
        live_candidates: () => {
          throw new FakeRpcFailure({ message: 'JWT expired', code: 'PGRST303' })
        },
      },
    })
    await expect(
      handleLive(deps, fakeRequest({ url: '/api/live?scope=world', bearer: 'expired' })),
    ).rejects.toMatchObject({ code: 'not_authenticated' })
    expect(supabase.calls.map((c) => c.client)).toEqual(['user:expired'])
  })

  it('visitors cannot list neighborhood or city lives', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { live_candidates: () => [] } })
    for (const scope of ['neighborhood', 'city', 'friends']) {
      await expect(
        handleLive(deps, fakeRequest({ url: `/api/live?scope=${scope}` })),
      ).rejects.toMatchObject({ code: 'not_authenticated' })
    }
    expect(supabase.calls).toHaveLength(0)
  })
})
