import { SEARCH_SECTION_SIZE, asAreaId, asPlaceId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { RPC } from './rpc'
import { earthRejection } from './testing/expect'
import { postgrestRaise } from './testing/fake-supabase'
import * as fixtures from './testing/fixtures'
import { createTestClient } from './testing/harness'

const { IDS } = fixtures
const AREA = asAreaId(IDS.area)
const CITY = asAreaId(IDS.city)
const PLACE = asPlaceId(IDS.place)

describe('feed / live', () => {
  it('feed.page gets /api/feed with scope, cursor and area', async () => {
    const { client, fetch } = createTestClient({
      accessToken: 'tok',
      fetchHandler: { json: fixtures.feedPage() },
    })
    const page = await client.feed.page('friends', 'cur_1', AREA)
    expect(page.cards).toHaveLength(2)
    expect(page.cards[1]?.kind).toBe('live')
    const request = fetch.lastRequest()
    expect(request.url).toBe(
      `https://api.earth.test/api/feed?scope=friends&cursor=cur_1&area=${IDS.area}`,
    )
    expect(request.method).toBe('GET')
    expect(request.headers['authorization']).toBe('Bearer tok')
  })

  it('feed.page lets Visitors read world without a bearer', async () => {
    const { client, fetch } = createTestClient({
      fetchHandler: { json: fixtures.feedPage({ scope: 'world', cards: [] }) },
    })
    expect((await client.feed.page('world')).scope).toBe('world')
    expect(fetch.lastRequest().url).toBe('https://api.earth.test/api/feed?scope=world')
    expect(fetch.lastRequest().headers['authorization']).toBeUndefined()
  })

  it('feed.page validates scope and maps route errors', async () => {
    const { client, fetch } = createTestClient({
      fetchHandler: { status: 401, json: { error: { code: 'not_authenticated', message: 'x' } } },
    })
    expect((await earthRejection(client.feed.page('galaxy' as never))).code).toBe('invalid_input')
    expect(fetch.requests).toHaveLength(0)
    expect((await earthRejection(client.feed.page('friends'))).code).toBe('not_authenticated')
  })

  it('live.list gets /api/live', async () => {
    const { client, fetch } = createTestClient({ fetchHandler: { json: fixtures.liveList() } })
    expect((await client.live.list('friends', CITY)).cards[0]?.title).toBe('Xavier is live')
    expect(fetch.lastRequest().url).toBe(
      `https://api.earth.test/api/live?scope=friends&area=${IDS.city}`,
    )
  })
})

describe('search / map', () => {
  it('search.query calls search(q, limit) with the section size', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.search, fixtures.searchResults())
    const results = await client.search.query(' maya ')
    expect(supabase.lastRpc()).toEqual({
      name: 'search',
      args: { q: 'maya', limit: SEARCH_SECTION_SIZE },
    })
    expect(results.people[0]?.handle).toBe('maya')
    expect((await earthRejection(client.search.query('   '))).code).toBe('invalid_input')
  })

  it('map.objects maps the bbox to min/max lat/lng', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.mapObjects, fixtures.mapObjects())
    const objects = await client.map.objects('city', [-122.5, 37.7, -122.3, 37.8])
    expect(supabase.lastRpc()).toEqual({
      name: 'map_objects',
      args: { scope: 'city', min_lat: 37.7, min_lng: -122.5, max_lat: 37.8, max_lng: -122.3 },
    })
    expect(objects.friends[0]?.precision).toBe('approximate')
    expect(
      (await earthRejection(client.map.objects('city', [-122.3, 37.7, -122.5, 37.8]))).code,
    ).toBe('invalid_input')
  })
})

describe('places', () => {
  it('search accepts arrays or wrapped lists', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.placesSearch, [fixtures.placeDto()])
    expect(await client.places.search({ q: 'dolores' })).toHaveLength(1)
    expect(supabase.lastRpc()).toEqual({
      name: 'places_search',
      args: { q: 'dolores', area_id: null },
    })
    supabase.rpcData(RPC.placesSearch, { places: [fixtures.placeDto()] })
    expect(await client.places.search({ q: 'dolores', areaId: AREA })).toHaveLength(1)
    expect(supabase.lastRpc().args).toEqual({ q: 'dolores', area_id: IDS.area })
  })

  it('get and create map their rpcs', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.placeGet, fixtures.placeDto())
    expect((await client.places.get(PLACE)).name).toBe('Dolores Park')
    expect(supabase.lastRpc()).toEqual({ name: 'place_get', args: { id: IDS.place } })
    supabase.rpcData(RPC.placeCreate, fixtures.placeDto())
    await client.places.create({
      name: 'Dolores Park',
      position: { lat: 37.7596, lng: -122.4269 },
      areaId: AREA,
      category: 'park',
    })
    expect(supabase.lastRpc()).toEqual({
      name: 'place_create',
      args: {
        name: 'Dolores Park',
        lat: 37.7596,
        lng: -122.4269,
        area_id: IDS.area,
        category: 'park',
      },
    })
  })
})

describe('location', () => {
  it('resolveArea sends lat/lng and parses both areas', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.areaResolve, fixtures.areaResolution())
    const resolution = await client.location.resolveArea({ lat: 37.76, lng: -122.42 })
    expect(supabase.lastRpc()).toEqual({ name: 'area_resolve', args: { lat: 37.76, lng: -122.42 } })
    expect(resolution.city?.name).toBe('San Francisco')
    expect((await earthRejection(client.location.resolveArea({ lat: 100, lng: 0 }))).code).toBe(
      'invalid_input',
    )
  })

  it('searchAreas and getArea map their rpcs', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.areasSearch, { areas: [fixtures.areaDto()] })
    expect(await client.location.searchAreas('miss')).toHaveLength(1)
    expect(supabase.lastRpc()).toEqual({ name: 'areas_search', args: { q: 'miss' } })
    supabase.rpcData(RPC.areaGet, fixtures.cityDto())
    expect((await client.location.getArea(CITY)).type).toBe('city')
    expect(supabase.lastRpc()).toEqual({ name: 'area_get', args: { id: IDS.city } })
  })

  it('setContext sends only ids and returns the context', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.contextSet, fixtures.humanContext())
    const context = await client.location.setContext({ currentCityId: CITY })
    expect(supabase.lastRpc()).toEqual({
      name: 'context_set',
      args: { current_area_id: null, current_city_id: IDS.city, home_city_id: null },
    })
    expect(context.currentCityName).toBe('San Francisco')
  })

  it('resolveAndSetContext is one RPC, context_resolve_and_set(lat, lng), answering the context', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.contextResolveAndSet, fixtures.humanContext())
    const context = await client.location.resolveAndSetContext({ lat: 37.76, lng: -122.42 })
    expect(context.currentCityName).toBe('San Francisco')
    expect(supabase.rpcCalls.map((call) => call.name)).toEqual(['context_resolve_and_set'])
    expect(supabase.lastRpc().args).toEqual({ lat: 37.76, lng: -122.42 })
    expect(
      (await earthRejection(client.location.resolveAndSetContext({ lat: 91, lng: 0 }))).code,
    ).toBe('invalid_input')
  })

  it('setScope maps to scope_set(surface, scope)', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.scopeSet, { surface: 'home', scope: 'city' })
    await client.location.setScope({ surface: 'home', scope: 'city' })
    expect(supabase.lastRpc()).toEqual({
      name: 'scope_set',
      args: { surface: 'home', scope: 'city' },
    })
    expect(
      (
        await earthRejection(
          client.location.setScope({ surface: 'sidebar' as never, scope: 'city' }),
        )
      ).code,
    ).toBe('invalid_input')
  })

  it('share converts minutes to seconds and never stores more than the position given', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.locationShareCreate, fixtures.locationShare())
    const share = await client.location.share({
      audienceType: 'friend',
      audienceId: IDS.maya,
      precision: 'approximate',
      durationMinutes: 60,
      position: { lat: 37.76, lng: -122.42 },
    })
    expect(supabase.lastRpc()).toEqual({
      name: 'location_share_create',
      args: {
        audience_type: 'friend',
        audience_id: IDS.maya,
        precision: 'approximate',
        duration_seconds: 3600,
        lat: 37.76,
        lng: -122.42,
      },
    })
    expect(share.precision).toBe('approximate')
    expect(
      (
        await earthRejection(
          client.location.share({
            audienceType: 'friend',
            audienceId: IDS.maya,
            precision: 'precise',
            durationMinutes: 24 * 60,
            position: { lat: 0, lng: 0 },
          }),
        )
      ).code,
    ).toBe('invalid_input')
  })

  it('share surfaces location_sharing_disabled', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcError(RPC.locationShareCreate, postgrestRaise('location_sharing_disabled'))
    expect(
      (
        await earthRejection(
          client.location.share({
            audienceType: 'friend',
            audienceId: IDS.maya,
            precision: 'city',
            durationMinutes: 60,
            position: { lat: 0, lng: 0 },
          }),
        )
      ).code,
    ).toBe('location_sharing_disabled')
  })

  it('updateShare, revokeShare and visibleShares map their rpcs', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.locationShareUpdate, fixtures.locationShare())
    expect(
      (await client.location.updateShare({ shareId: IDS.share, position: { lat: 1, lng: 2 } })).id,
    ).toBe(IDS.share)
    expect(supabase.lastRpc()).toEqual({
      name: 'location_share_update',
      args: { share_id: IDS.share, lat: 1, lng: 2 },
    })
    supabase.rpcData(RPC.locationShareRevoke, fixtures.locationShare({ revokedAt: fixtures.AT }))
    expect((await client.location.revokeShare(IDS.share)).revokedAt).toBe(fixtures.AT)
    expect(supabase.lastRpc()).toEqual({
      name: 'location_share_revoke',
      args: { share_id: IDS.share },
    })
    supabase.rpcData(RPC.locationSharesVisible, [fixtures.mapFriend()])
    expect((await client.location.visibleShares())[0]?.displayName).toBe('Maya')
    expect(supabase.lastRpc()).toEqual({ name: 'location_shares_visible', args: {} })
  })

  it('myShares calls location_shares_mine and accepts an array, { shares } or null', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.locationSharesMine, [fixtures.locationShare()])
    const mine = await client.location.myShares()
    expect(supabase.lastRpc()).toEqual({ name: 'location_shares_mine', args: {} })
    expect(mine.map((share) => share.id)).toEqual([IDS.share])
    expect(mine[0]?.audienceId).toBe(IDS.maya)
    supabase.rpcData(RPC.locationSharesMine, { shares: [fixtures.locationShare()] })
    expect(await client.location.myShares()).toHaveLength(1)
    supabase.rpcData(RPC.locationSharesMine, null)
    expect(await client.location.myShares()).toEqual([])
    supabase.rpcError(RPC.locationSharesMine, postgrestRaise('not_authenticated'))
    expect((await earthRejection(client.location.myShares())).code).toBe('not_authenticated')
  })
})
