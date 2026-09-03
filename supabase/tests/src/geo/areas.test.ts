/**
 * Areas, places and context resolution (spec §37–38, §52, §74, §76; DB_API §5): the base rows of
 * 0510, area_resolve (ST_Contains on the smallest matching areas, storing nothing), areas_search /
 * area_get, places_search / place_get / place_create and context_resolve_and_set (area ids only,
 * never coordinates) for every caller kind.
 */
import { readFile } from 'node:fs/promises'

import { AreaDtoSchema, HumanContextDtoSchema, PlaceDtoSchema } from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  BASE_AREA_SLUGS,
  BASE_PLACE_KEYS,
  POINTS,
  areaBySlug,
  contextRow,
  coordinateColumns,
  coordinateDigest,
  count,
  createGuest,
  createHuman,
  createUnclaimed,
  human,
  placeByKey,
  scalar,
  tablesMentioning,
  type Human,
} from './fixtures'

const SEED_FILE = new URL('../../../seed/areas.sql', import.meta.url)

/** The literal coordinate fragments a stored copy of the probe positions would contain. */
const PROBE_FRAGMENTS = ['37.80456', '122.41567', '37.77123', '122.49234']

describe('areas, places and context (DB_API §5)', () => {
  let db: TestDb
  let sf: string
  let northBeach: string
  let mission: string
  let oakland: string
  let alice: Human
  let guest: RoleSpec
  let claiming: Human
  let unclaimed: RoleSpec

  beforeAll(async () => {
    db = await createTestDb()
    sf = await areaBySlug(db, BASE_AREA_SLUGS.sanFrancisco)
    northBeach = await areaBySlug(db, BASE_AREA_SLUGS.northBeach)
    mission = await areaBySlug(db, BASE_AREA_SLUGS.mission)
    oakland = await areaBySlug(db, BASE_AREA_SLUGS.oakland)
    alice = await human(db, 'Alice')
    guest = (await createGuest(db)).as
    claiming = await createHuman(db, { handle: 'claiming', status: 'pending' })
    unclaimed = (await createUnclaimed(db)).as
  })

  afterAll(async () => {
    await db.drop()
  })

  describe('base rows (0510)', () => {
    it('ships the countries, regions, cities and San Francisco neighborhoods as non-fixture rows', async () => {
      const { rows } = await db.sql.query<{
        slug: string
        type: string
        name: string
        parent: string | null
        is_fixture: boolean
        has_geometry: boolean
        has_bbox: boolean
      }>(
        `select a.slug, a.type::text, a.name, p.slug as parent, a.is_fixture,
                a.geometry is not null as has_geometry, a.bbox is not null as has_bbox
           from public.areas a left join public.areas p on p.id = a.parent_area_id
          where a.slug = any($1) order by a.slug`,
        [Object.values(BASE_AREA_SLUGS)],
      )
      expect(rows.map((r) => r.slug).sort()).toEqual(Object.values(BASE_AREA_SLUGS).sort())
      for (const row of rows) {
        expect(row.is_fixture, row.slug).toBe(false)
        expect(row.has_geometry, row.slug).toBe(true)
        expect(row.has_bbox, row.slug).toBe(true)
      }
      const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]))
      expect(bySlug[BASE_AREA_SLUGS.unitedStates]).toMatchObject({ type: 'country', parent: null })
      expect(bySlug[BASE_AREA_SLUGS.california]).toMatchObject({
        type: 'region',
        parent: BASE_AREA_SLUGS.unitedStates,
      })
      expect(bySlug[BASE_AREA_SLUGS.newYorkState]).toMatchObject({
        type: 'region',
        parent: BASE_AREA_SLUGS.unitedStates,
      })
      for (const slug of [
        BASE_AREA_SLUGS.sanFrancisco,
        BASE_AREA_SLUGS.oakland,
        BASE_AREA_SLUGS.losAngeles,
      ]) {
        expect(bySlug[slug]).toMatchObject({ type: 'city', parent: BASE_AREA_SLUGS.california })
      }
      expect(bySlug[BASE_AREA_SLUGS.newYork]).toMatchObject({
        type: 'city',
        name: 'New York',
        parent: BASE_AREA_SLUGS.newYorkState,
      })
      for (const slug of [
        BASE_AREA_SLUGS.northBeach,
        BASE_AREA_SLUGS.mission,
        BASE_AREA_SLUGS.doloresHeights,
        BASE_AREA_SLUGS.hayesValley,
        BASE_AREA_SLUGS.soma,
        BASE_AREA_SLUGS.marina,
      ]) {
        expect(bySlug[slug]).toMatchObject({
          type: 'neighborhood',
          parent: BASE_AREA_SLUGS.sanFrancisco,
        })
      }
      expect(bySlug[BASE_AREA_SLUGS.soma]?.name).toBe('SoMa')
    })

    it('keeps the San Francisco neighborhoods inside the city and free of overlaps', async () => {
      expect(
        await scalar<string>(
          db,
          `select count(*) from public.areas n join public.areas c on c.id = n.parent_area_id
            where n.type = 'neighborhood' and c.slug = $1 and not st_covers(c.geometry, n.geometry)`,
          [BASE_AREA_SLUGS.sanFrancisco],
        ),
      ).toBe('0')
      expect(
        await scalar<string>(
          db,
          `select count(*) from public.areas a join public.areas b on b.id > a.id
            where a.type = 'neighborhood' and b.type = 'neighborhood' and a.parent_area_id = b.parent_area_id
              and not a.is_fixture and not b.is_fixture and st_overlaps(a.geometry, b.geometry)`,
        ),
      ).toBe('0')
      for (const slug of Object.values(BASE_AREA_SLUGS)) {
        expect(
          await scalar<boolean>(
            db,
            'select st_contains(geometry, centroid) from public.areas where slug = $1',
            [slug],
          ),
          slug,
        ).toBe(true)
      }
    })

    it('ships Dolores Park, Washington Square Park and the Ferry Building as public places', async () => {
      const { rows } = await db.sql.query<{
        key: string
        name: string
        area: string
        visibility: string
        is_fixture: boolean
      }>(
        `select p.provider_reference as key, p.name, a.slug as area, p.visibility, p.is_fixture
           from public.places p join public.areas a on a.id = p.area_id
          where p.provider_reference = any($1) order by p.name`,
        [BASE_PLACE_KEYS.map((key) => `earth:${key}`)],
      )
      expect(rows).toEqual([
        {
          key: 'earth:dolores-park',
          name: 'Dolores Park',
          area: BASE_AREA_SLUGS.mission,
          visibility: 'public',
          is_fixture: false,
        },
        {
          key: 'earth:ferry-building',
          name: 'Ferry Building',
          area: BASE_AREA_SLUGS.sanFrancisco,
          visibility: 'public',
          is_fixture: false,
        },
        {
          key: 'earth:washington-square-park',
          name: 'Washington Square Park',
          area: BASE_AREA_SLUGS.northBeach,
          visibility: 'public',
          is_fixture: false,
        },
      ])
    })

    it('exposes the upsert helpers to the owner and service only', async () => {
      for (const role of ['anon', 'authenticated', 'public']) {
        for (const fn of [
          'earth.area_upsert(text, public.area_type, text, text, double precision, double precision, text, boolean)',
          'earth.place_upsert(text, text, text, double precision, double precision, text, boolean)',
        ]) {
          expect(
            await scalar<boolean>(db, 'select has_function_privilege($1, $2, $3)', [
              role,
              fn,
              'EXECUTE',
            ]),
            `${role} ${fn}`,
          ).toBe(false)
        }
      }
    })

    it('the development seed adds fixture areas and places idempotently', async () => {
      const seed = await readFile(SEED_FILE, 'utf8')
      const baseAreas = await count(db, 'public.areas')
      const basePlaces = await count(db, 'public.places')
      await db.sql.query(seed)
      const areas = await count(db, 'public.areas')
      const places = await count(db, 'public.places')
      expect(areas).toBeGreaterThan(baseAreas)
      expect(places).toBeGreaterThan(basePlaces)
      expect(await count(db, 'public.areas', 'is_fixture')).toBe(areas - baseAreas)
      expect(await count(db, 'public.places', 'is_fixture')).toBe(places - basePlaces)
      await db.sql.query(seed)
      expect(await count(db, 'public.areas')).toBe(areas)
      expect(await count(db, 'public.places')).toBe(places)
      // Fixture neighborhoods resolve like base ones and hang off the base cities.
      const temescal = await db.rpc<{
        neighborhood: { name: string } | null
        city: { name: string } | null
      }>('area_resolve', { lat: 37.834, lng: -122.262 }, alice.as)
      expect(temescal.neighborhood?.name).toBe('Temescal')
      expect(temescal.city?.name).toBe('Oakland')
      const williamsburg = await db.rpc<{
        neighborhood: { name: string } | null
        city: { name: string } | null
      }>('area_resolve', { lat: 40.7081, lng: -73.9571 }, alice.as)
      expect(williamsburg.neighborhood?.name).toBe('Williamsburg')
      expect(williamsburg.city?.name).toBe('New York')
      // Remove the fixtures again so the remaining tests see the production shape.
      await db.sql.query('delete from public.places where is_fixture')
      await db.sql.query('delete from public.areas where is_fixture')
      expect(await count(db, 'public.areas')).toBe(baseAreas)
      expect(await count(db, 'public.places')).toBe(basePlaces)
    })
  })

  describe('area_resolve', () => {
    it('is for signed-in callers of every kind, never visitors', async () => {
      await db.expectError(
        db.rpc('area_resolve', { lat: 37.8, lng: -122.4 }, 'visitor'),
        'not_authenticated',
      )
      for (const as of [guest, claiming.as, unclaimed, alice.as, 'service' as const]) {
        const result = await db.rpc<{ city: { name: string } | null }>(
          'area_resolve',
          POINTS.northBeach,
          as,
        )
        expect(result.city?.name).toBe('San Francisco')
      }
    })

    it('returns North Beach + San Francisco for a coordinate in North Beach', async () => {
      const result = await db.rpc<{ neighborhood: unknown; city: unknown }>(
        'area_resolve',
        POINTS.northBeach,
        alice.as,
      )
      const neighborhood = AreaDtoSchema.parse(result.neighborhood)
      const city = AreaDtoSchema.parse(result.city)
      expect(neighborhood).toMatchObject({
        id: northBeach,
        type: 'neighborhood',
        name: 'North Beach',
        parentAreaId: sf,
      })
      expect(city).toMatchObject({
        id: sf,
        type: 'city',
        name: 'San Francisco',
        centroid: { lat: 37.7749, lng: -122.4194 },
      })
    })

    it('returns only the city for a San Francisco coordinate outside the seeded neighborhoods', async () => {
      const result = await db.rpc<{ neighborhood: unknown; city: { id: string } | null }>(
        'area_resolve',
        POINTS.goldenGatePark,
        alice.as,
      )
      expect(result.neighborhood).toBeNull()
      expect(result.city?.id).toBe(sf)
      const eastBay = await db.rpc<{ neighborhood: unknown; city: { id: string } | null }>(
        'area_resolve',
        POINTS.oakland,
        alice.as,
      )
      expect(eastBay.neighborhood).toBeNull()
      expect(eastBay.city?.id).toBe(oakland)
    })

    it('returns null/null for the ocean', async () => {
      expect(await db.rpc('area_resolve', POINTS.ocean, alice.as)).toEqual({
        neighborhood: null,
        city: null,
      })
    })

    it('prefers the smallest containing area and resolves the city through the neighborhood', async () => {
      // A huge fixture neighborhood covering all of San Francisco must lose to Mission.
      const { rows } = await db.sql.query<{ id: string }>(
        `insert into public.areas (type, name, slug, parent_area_id, geometry, centroid, is_fixture)
         values ('neighborhood', 'Everywhere', 'probe-everywhere', $1,
                 st_multi(st_geomfromtext('POLYGON((-122.52 37.70, -122.355 37.70, -122.355 37.835, -122.52 37.835, -122.52 37.70))', 4326)),
                 st_setsrid(st_makepoint(-122.44, 37.76), 4326), true)
         returning id`,
        [sf],
      )
      const everywhere = rows[0]?.id
      const result = await db.rpc<{ neighborhood: { id: string } | null }>(
        'area_resolve',
        POINTS.mission,
        alice.as,
      )
      expect(result.neighborhood?.id).toBe(mission)
      // A neighborhood whose polygon lies outside its city's coarse polygon still yields its city.
      await db.sql.query(
        `update public.areas set geometry = st_multi(st_geomfromtext('POLYGON((10 10, 11 10, 11 11, 10 11, 10 10))', 4326)) where id = $1`,
        [everywhere],
      )
      const outside = await db.rpc<{
        neighborhood: { id: string } | null
        city: { id: string } | null
      }>('area_resolve', { lat: 10.5, lng: 10.5 }, alice.as)
      expect(outside.neighborhood?.id).toBe(everywhere)
      expect(outside.city?.id).toBe(sf)
      await db.sql.query('delete from public.areas where id = $1', [everywhere])
    })

    it('rejects coordinates outside the valid ranges', async () => {
      await db.expectError(db.rpc('area_resolve', { lat: 91, lng: 0 }, alice.as), 'invalid_input')
      await db.expectError(db.rpc('area_resolve', { lat: 0, lng: -181 }, alice.as), 'invalid_input')
      await db.expectError(db.rpc('area_resolve', { lat: null, lng: 0 }, alice.as), 'invalid_input')
    })

    it('stores nothing: no coordinate-typed column changes and no row mentions the input', async () => {
      const before = await coordinateDigest(db)
      const positions = await count(db, 'public.location_share_positions')
      const probed = await db.rpc<{
        neighborhood: { id: string } | null
        city: { id: string } | null
      }>('area_resolve', POINTS.northBeachProbe, alice.as)
      expect(probed.neighborhood?.id).toBe(northBeach)
      expect(
        (
          await db.rpc<{ neighborhood: unknown; city: { id: string } | null }>(
            'area_resolve',
            POINTS.parkProbe,
            guest,
          )
        ).city?.id,
      ).toBe(sf)
      await db.rpc('area_resolve', POINTS.ocean, alice.as)
      expect(await coordinateDigest(db)).toEqual(before)
      expect(await count(db, 'public.location_share_positions')).toBe(positions)
      expect(await tablesMentioning(db, PROBE_FRAGMENTS)).toEqual([])
    })
  })

  describe('areas_search / area_get', () => {
    it('finds areas by name for everyone, best match first', async () => {
      const results = await db.rpc<unknown[]>('areas_search', { q: 'miss' }, 'visitor')
      expect(results.map((r) => AreaDtoSchema.parse(r).name)[0]).toBe('Mission')
      const sanFrancisco = await db.rpc<Array<{ id: string }>>(
        'areas_search',
        { q: 'san fran' },
        guest,
      )
      expect(sanFrancisco.map((r) => r.id)).toContain(sf)
      const fuzzy = await db.rpc<Array<{ name: string }>>(
        'areas_search',
        { q: 'Hayes Vally' },
        alice.as,
      )
      expect(fuzzy[0]?.name).toBe('Hayes Valley')
      expect(await db.rpc('areas_search', { q: 'zzzzqqq' }, alice.as)).toEqual([])
      // Wildcards are literal characters, not patterns.
      expect(await db.rpc('areas_search', { q: '%' }, alice.as)).toEqual([])
    })

    it('validates the query', async () => {
      await db.expectError(db.rpc('areas_search', { q: '   ' }, alice.as), 'invalid_input')
      await db.expectError(
        db.rpc('areas_search', { q: 'x'.repeat(101) }, alice.as),
        'invalid_input',
      )
      await db.expectError(db.rpc('areas_search', { q: null }, alice.as), 'invalid_input')
    })

    it('area_get returns an AreaDto to everyone and area_not_found otherwise', async () => {
      for (const as of ['visitor' as const, guest, alice.as]) {
        expect(AreaDtoSchema.parse(await db.rpc('area_get', { id: northBeach }, as))).toMatchObject(
          {
            id: northBeach,
            name: 'North Beach',
            parentAreaId: sf,
          },
        )
      }
      await db.expectError(
        db.rpc('area_get', { id: '00000000-0000-0000-0000-000000000000' }, alice.as),
        'area_not_found',
      )
    })
  })

  describe('places_search / place_get / place_create', () => {
    let doloresPark: string
    let privatePlace: string

    beforeAll(async () => {
      doloresPark = await placeByKey(db, 'dolores-park')
      const { rows } = await db.sql.query<{ id: string }>(
        `insert into public.places (name, area_id, location, visibility, created_by_human_id)
         values ('Secret Park', $1, st_setsrid(st_makepoint(-122.41, 37.76), 4326), 'private', $2) returning id`,
        [mission, alice.humanId],
      )
      privatePlace = rows[0]?.id ?? ''
    })

    it('searches public places by name, optionally inside an area, for everyone', async () => {
      const parks = await db.rpc<unknown[]>(
        'places_search',
        { q: 'park', area_id: null },
        'visitor',
      )
      const names = parks.map((p) => PlaceDtoSchema.parse(p).name)
      expect(names).toContain('Dolores Park')
      expect(names).toContain('Washington Square Park')
      expect(names).not.toContain('Secret Park')
      const inNorthBeach = await db.rpc<Array<{ name: string }>>(
        'places_search',
        { q: 'park', area_id: northBeach },
        guest,
      )
      expect(inNorthBeach.map((p) => p.name)).toEqual(['Washington Square Park'])
      const inCity = await db.rpc<Array<{ name: string }>>(
        'places_search',
        { q: 'park', area_id: sf },
        alice.as,
      )
      expect(inCity.map((p) => p.name)).toEqual(
        expect.arrayContaining(['Dolores Park', 'Washington Square Park', 'Secret Park']),
      )
      expect(await db.rpc('places_search', { q: 'park', area_id: oakland }, alice.as)).toEqual([])
      await db.expectError(
        db.rpc(
          'places_search',
          { q: 'park', area_id: '00000000-0000-0000-0000-000000000000' },
          alice.as,
        ),
        'area_not_found',
      )
      await db.expectError(
        db.rpc('places_search', { q: '', area_id: null }, alice.as),
        'invalid_input',
      )
    })

    it("place_get returns a PlaceDto; private places are the creator's only", async () => {
      const dto = PlaceDtoSchema.parse(await db.rpc('place_get', { id: doloresPark }, 'visitor'))
      expect(dto).toMatchObject({
        id: doloresPark,
        name: 'Dolores Park',
        areaId: mission,
        areaName: 'Mission',
        lat: 37.7596,
        lng: -122.427,
        category: 'park',
        visibility: 'public',
      })
      expect(
        PlaceDtoSchema.parse(await db.rpc('place_get', { id: privatePlace }, alice.as)).visibility,
      ).toBe('private')
      const bob = await human(db, 'Bob')
      await db.expectError(db.rpc('place_get', { id: privatePlace }, bob.as), 'not_visible')
      await db.expectError(db.rpc('place_get', { id: privatePlace }, 'visitor'), 'not_visible')
      await db.expectError(
        db.rpc('place_get', { id: '00000000-0000-0000-0000-000000000000' }, alice.as),
        'not_visible',
      )
    })

    it('place_create is for active Humans only', async () => {
      const args = {
        name: 'Caffe Trieste',
        lat: POINTS.northBeach.lat,
        lng: POINTS.northBeach.lng,
        area_id: null,
        category: 'cafe',
      }
      await db.expectError(db.rpc('place_create', args, 'visitor'), 'not_authenticated')
      await db.expectError(db.rpc('place_create', args, guest), 'not_a_human')
      await db.expectError(db.rpc('place_create', args, claiming.as), 'not_a_human')
      await db.expectError(db.rpc('place_create', args, unclaimed), 'not_a_human')
      const suspended = await createHuman(db, { handle: 'suspended', status: 'suspended' })
      await db.expectError(db.rpc('place_create', args, suspended.as), 'human_not_active')
    })

    it('resolves the area from the position when none is given and validates the input', async () => {
      const created = PlaceDtoSchema.parse(
        await db.rpc(
          'place_create',
          {
            name: '  Caffe Trieste ',
            lat: POINTS.northBeach.lat,
            lng: POINTS.northBeach.lng,
            area_id: null,
            category: 'cafe',
          },
          alice.as,
        ),
      )
      expect(created).toMatchObject({
        name: 'Caffe Trieste',
        areaId: northBeach,
        areaName: 'North Beach',
        lat: POINTS.northBeach.lat,
        lng: POINTS.northBeach.lng,
        category: 'cafe',
        visibility: 'public',
      })
      expect(
        await scalar<string>(db, 'created_by_human_id from public.places where id = $1', [
          created.id,
        ]),
      ).toBe(alice.humanId)
      // The same public place in the same area is reused rather than duplicated.
      const again = PlaceDtoSchema.parse(
        await db.rpc(
          'place_create',
          {
            name: 'caffe trieste',
            lat: POINTS.northBeach.lat + 0.0001,
            lng: POINTS.northBeach.lng,
            area_id: null,
            category: null,
          },
          alice.as,
        ),
      )
      expect(again.id).toBe(created.id)
      // A city-level position (no neighborhood) lands in the city; an explicit area wins.
      const inCity = PlaceDtoSchema.parse(
        await db.rpc(
          'place_create',
          {
            name: 'Conservatory of Flowers',
            lat: POINTS.goldenGatePark.lat,
            lng: POINTS.goldenGatePark.lng,
            area_id: null,
            category: null,
          },
          alice.as,
        ),
      )
      expect(inCity.areaId).toBe(sf)
      const explicit = PlaceDtoSchema.parse(
        await db.rpc(
          'place_create',
          {
            name: 'Somewhere',
            lat: POINTS.goldenGatePark.lat,
            lng: POINTS.goldenGatePark.lng,
            area_id: mission,
            category: null,
          },
          alice.as,
        ),
      )
      expect(explicit.areaId).toBe(mission)
      await db.expectError(
        db.rpc(
          'place_create',
          {
            name: 'Raft',
            lat: POINTS.ocean.lat,
            lng: POINTS.ocean.lng,
            area_id: null,
            category: null,
          },
          alice.as,
        ),
        'area_not_found',
      )
      await db.expectError(
        db.rpc(
          'place_create',
          {
            name: 'Raft',
            lat: POINTS.ocean.lat,
            lng: POINTS.ocean.lng,
            area_id: '00000000-0000-0000-0000-000000000000',
            category: null,
          },
          alice.as,
        ),
        'area_not_found',
      )
      await db.expectError(
        db.rpc(
          'place_create',
          {
            name: '   ',
            lat: POINTS.northBeach.lat,
            lng: POINTS.northBeach.lng,
            area_id: null,
            category: null,
          },
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'place_create',
          {
            name: 'x'.repeat(121),
            lat: POINTS.northBeach.lat,
            lng: POINTS.northBeach.lng,
            area_id: null,
            category: null,
          },
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'place_create',
          {
            name: 'Spot',
            lat: POINTS.northBeach.lat,
            lng: POINTS.northBeach.lng,
            area_id: null,
            category: 'c'.repeat(61),
          },
          alice.as,
        ),
        'invalid_input',
      )
      await db.expectError(
        db.rpc(
          'place_create',
          { name: 'Spot', lat: 95, lng: 0, area_id: null, category: null },
          alice.as,
        ),
        'invalid_input',
      )
    })

    it('place_create is rate limited (20 per hour)', async () => {
      const carol = await human(db, 'Carol')
      for (let i = 0; i < 20; i += 1) {
        await db.rpc(
          'place_create',
          {
            name: `Spot ${i}`,
            lat: POINTS.mission.lat,
            lng: POINTS.mission.lng,
            area_id: null,
            category: null,
          },
          carol.as,
        )
      }
      await db.expectError(
        db.rpc(
          'place_create',
          {
            name: 'Spot 20',
            lat: POINTS.mission.lat,
            lng: POINTS.mission.lng,
            area_id: null,
            category: null,
          },
          carol.as,
        ),
        'rate_limited',
      )
    })
  })

  describe('context_resolve_and_set', () => {
    it('is for active Humans only', async () => {
      await db.expectError(
        db.rpc('context_resolve_and_set', POINTS.northBeach, 'visitor'),
        'not_authenticated',
      )
      await db.expectError(
        db.rpc('context_resolve_and_set', POINTS.northBeach, guest),
        'not_a_human',
      )
      await db.expectError(
        db.rpc('context_resolve_and_set', POINTS.northBeach, claiming.as),
        'not_a_human',
      )
      await db.expectError(
        db.rpc('context_resolve_and_set', { lat: 200, lng: 0 }, alice.as),
        'invalid_input',
      )
    })

    it('stores only the resolved area ids and returns the HumanContextDto', async () => {
      const dave = await human(db, 'Dave')
      expect(await contextRow(db, dave)).toBeNull()
      const before = await coordinateDigest(db)

      const inNorthBeach = HumanContextDtoSchema.parse(
        await db.rpc('context_resolve_and_set', POINTS.northBeachProbe, dave.as),
      )
      expect(inNorthBeach).toEqual({
        currentAreaId: northBeach,
        currentAreaName: 'North Beach',
        currentCityId: sf,
        currentCityName: 'San Francisco',
        homeCityId: null,
      })
      expect(await contextRow(db, dave)).toEqual({
        current_area_id: northBeach,
        current_city_id: sf,
        home_city_id: null,
      })

      // Inside the city but outside every seeded neighborhood: the neighborhood clears, the city stays.
      const inPark = HumanContextDtoSchema.parse(
        await db.rpc('context_resolve_and_set', POINTS.parkProbe, dave.as),
      )
      expect(inPark).toMatchObject({
        currentAreaId: null,
        currentAreaName: null,
        currentCityId: sf,
      })
      expect(await contextRow(db, dave)).toEqual({
        current_area_id: null,
        current_city_id: sf,
        home_city_id: null,
      })

      // Back in North Beach, then somewhere unknown: an unresolvable position changes nothing.
      await db.rpc('context_resolve_and_set', POINTS.northBeachProbe, dave.as)
      const atSea = HumanContextDtoSchema.parse(
        await db.rpc('context_resolve_and_set', POINTS.ocean, dave.as),
      )
      expect(atSea).toMatchObject({ currentAreaId: northBeach, currentCityId: sf })
      expect(await contextRow(db, dave)).toEqual({
        current_area_id: northBeach,
        current_city_id: sf,
        home_city_id: null,
      })

      // Another city replaces both.
      const eastBay = HumanContextDtoSchema.parse(
        await db.rpc('context_resolve_and_set', POINTS.oakland, dave.as),
      )
      expect(eastBay).toMatchObject({
        currentAreaId: null,
        currentCityId: oakland,
        currentCityName: 'Oakland',
      })

      // me_get reflects the same context.
      const me = await db.rpc<{ context: unknown }>('me_get', {}, dave.as)
      expect(HumanContextDtoSchema.parse(me.context).currentCityId).toBe(oakland)

      // Nothing geographic was written anywhere: no coordinate column changed, no row mentions the input.
      expect(await coordinateDigest(db)).toEqual(before)
      expect(await tablesMentioning(db, PROBE_FRAGMENTS)).toEqual([])
    })

    it('human_context has no coordinate-typed column', async () => {
      const columns = (await coordinateColumns(db)).filter((c) => c.table === 'human_context')
      expect(columns).toEqual([])
      const { rows } = await db.sql.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'human_context' order by 1`,
      )
      expect(rows.map((r) => r.column_name)).toEqual([
        'current_area_id',
        'current_city_id',
        'home_city_id',
        'human_id',
        'last_scope_earth',
        'last_scope_home',
        'last_scope_live',
        'updated_at',
      ])
    })

    it('a fresh Human without context gets a row of nulls for an unknown position', async () => {
      const erin = await human(db, 'Erin')
      const dto = HumanContextDtoSchema.parse(
        await db.rpc('context_resolve_and_set', POINTS.ocean, erin.as),
      )
      expect(dto).toEqual({
        currentAreaId: null,
        currentAreaName: null,
        currentCityId: null,
        currentCityName: null,
        homeCityId: null,
      })
      expect(await contextRow(db, erin)).toEqual({
        current_area_id: null,
        current_city_id: null,
        home_city_id: null,
      })
    })
  })
})
