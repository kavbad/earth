import {
  AreaDtoSchema,
  MeDtoSchema,
  ProfileDtoSchema,
  PublicIdentityDtoSchema,
} from '@earth/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import {
  befriend,
  block,
  createArea,
  createGuest,
  createHuman,
  createUnclaimed,
  isPermissionDenied,
  scalar,
  setFlag,
  setSetting,
  type Human,
} from './fixtures'

const UNIQUE_VIOLATION = '23505'

async function expectDenied(promise: Promise<unknown>): Promise<void> {
  let failure: unknown
  try {
    await promise
  } catch (error) {
    failure = error
  }
  expect(isPermissionDenied(failure), `expected permission denied, got ${String(failure)}`).toBe(
    true,
  )
}

describe('feature flags and app settings (0006)', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
    await db.sql.query(`
      create function public.probe_flag(key text) returns boolean
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.flag(key) $$;
      create function public.probe_setting(key text) returns text
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.setting(key) $$;
      grant execute on function public.probe_flag(text) to anon, authenticated;
      grant execute on function public.probe_setting(text) to anon, authenticated;
    `)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('seeds the launch defaults (ARCHITECTURE §12) and the runtime settings', async () => {
    const { rows } = await db.sql.query<{ key: string; enabled: boolean }>(
      'select key, enabled from public.feature_flags order by key',
    )
    expect(Object.fromEntries(rows.map((r) => [r.key, r.enabled]))).toEqual({
      CITY_ENABLED: true,
      FRIENDS_LIVE_EXPANSION_ENABLED: true,
      GROUP_ANCHORED_CLAIM_REQUIRED: true,
      GUEST_ROOMS_ENABLED: true,
      LOCATION_SHARING_ENABLED: true,
      MAFIA_ACTIVITY_ENABLED: false,
      NEIGHBORHOOD_ENABLED: true,
      PUBLIC_LIVE_ENABLED: true,
      PUBLIC_WORLD_ENABLED: true,
      WORLD_ENABLED: true,
      WORLD_LIVE_EXPANSION_ENABLED: true,
    })
    const settings = await db.sql.query<{ key: string; value: string }>(
      'select key, value from public.app_settings order by key',
    )
    expect(Object.fromEntries(settings.rows.map((r) => [r.key, r.value]))).toEqual({
      environment: 'development',
      // Spec §84 launch policy, seeded by 1020.
      minimum_age_policy: '18_plus',
      public_storage_base_url: '',
      room_grace_seconds: '120',
      web_origin: 'https://earth.social',
    })
  })

  it('earth.flag() is false for a missing key and earth.setting() null', async () => {
    expect(await db.rpc('probe_flag', { key: 'GROUP_ANCHORED_CLAIM_REQUIRED' }, 'visitor')).toBe(
      true,
    )
    expect(await db.rpc('probe_flag', { key: 'MAFIA_ACTIVITY_ENABLED' }, 'visitor')).toBe(false)
    expect(await db.rpc('probe_flag', { key: 'NO_SUCH_FLAG' }, 'visitor')).toBe(false)
    expect(await db.rpc('probe_setting', { key: 'room_grace_seconds' }, 'visitor')).toBe('120')
    expect(await db.rpc('probe_setting', { key: 'no_such_setting' }, 'visitor')).toBeNull()
    await setFlag(db, 'MAFIA_ACTIVITY_ENABLED', true)
    expect(await db.rpc('probe_flag', { key: 'MAFIA_ACTIVITY_ENABLED' }, 'visitor')).toBe(true)
  })

  it('is readable by every caller and writable by nobody but the service', async () => {
    const guest = await createGuest(db)
    for (const as of ['visitor', guest.as] as RoleSpec[]) {
      const flags = await db.asRole(as, (c) => c.query('select key from public.feature_flags'))
      expect(flags.rowCount).toBe(11)
      const settings = await db.asRole(as, (c) => c.query('select key from public.app_settings'))
      expect(settings.rowCount).toBe(5)
      await expectDenied(
        db.asRole(as, (c) =>
          c.query("insert into public.feature_flags (key, enabled) values ('X_FLAG', true)"),
        ),
      )
      await expectDenied(
        db.asRole(as, (c) => c.query("update public.app_settings set value = 'x'")),
      )
    }
    await db.asRole('service', (c) =>
      c.query("update public.app_settings set value = '90' where key = 'room_grace_seconds'"),
    )
    expect(await db.rpc('probe_setting', { key: 'room_grace_seconds' }, 'visitor')).toBe('90')
  })

  it('rejects malformed keys and non-object payloads', async () => {
    await expect(
      db.sql.query("insert into public.feature_flags (key) values ('lowercase')"),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      db.sql.query(`insert into public.feature_flags (key, payload) values ('OK_FLAG', '[1]')`),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('areas and places (0050)', () => {
  let db: TestDb
  let country: string
  let region: string
  let city: string
  let hood: string
  let otherCity: string

  beforeAll(async () => {
    db = await createTestDb()
    country = await createArea(db, { name: 'United States', slug: 'us', type: 'country' })
    region = await createArea(db, {
      name: 'California',
      slug: 'ca',
      type: 'region',
      parentAreaId: country,
    })
    city = await createArea(db, {
      name: 'San Francisco',
      slug: 'sf',
      type: 'city',
      parentAreaId: region,
    })
    hood = await createArea(db, {
      name: 'Mission',
      slug: 'sf-mission',
      type: 'neighborhood',
      parentAreaId: city,
    })
    otherCity = await createArea(db, {
      name: 'Oakland',
      slug: 'oakland',
      type: 'city',
      parentAreaId: region,
    })
    await db.sql.query(`
      create function public.probe_area_contains(parent uuid, child uuid) returns boolean
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.area_contains(parent, child) $$;
      create function public.probe_area_json(id uuid) returns jsonb
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.area_json(id) $$;
      grant execute on function public.probe_area_contains(uuid, uuid) to anon, authenticated;
      grant execute on function public.probe_area_json(uuid) to anon, authenticated;
    `)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('area_contains walks the parent chain', async () => {
    const contains = (parent: string | null, child: string | null) =>
      db.rpc<boolean>('probe_area_contains', { parent, child }, 'visitor')
    expect(await contains(city, hood)).toBe(true)
    expect(await contains(region, hood)).toBe(true)
    expect(await contains(country, hood)).toBe(true)
    expect(await contains(city, city)).toBe(true)
    expect(await contains(hood, city)).toBe(false)
    expect(await contains(otherCity, hood)).toBe(false)
    expect(await contains(null, hood)).toBe(false)
    expect(await contains(city, null)).toBe(false)
    expect(await scalar<string | null>(db, "earth.area_ancestor_of_type($1, 'city')", [hood])).toBe(
      city,
    )
    expect(
      await scalar<string | null>(db, "earth.area_ancestor_of_type($1, 'country')", [hood]),
    ).toBe(country)
    expect(
      await scalar<string | null>(db, "earth.area_ancestor_of_type($1, 'neighborhood')", [city]),
    ).toBeNull()
  })

  it('area_json is an AreaDto with a lat/lng centroid', async () => {
    const dto = AreaDtoSchema.parse(await db.rpc('probe_area_json', { id: hood }, 'visitor'))
    expect(dto).toMatchObject({
      id: hood,
      type: 'neighborhood',
      name: 'Mission',
      parentAreaId: city,
      centroid: { lat: 37.77, lng: -122.42 },
    })
    expect(
      await db.rpc('probe_area_json', { id: '00000000-0000-0000-0000-000000000000' }, 'visitor'),
    ).toBeNull()
  })

  it('places derive lat/lng from the PostGIS point and enforce visibility values', async () => {
    const { rows } = await db.sql.query<{ lat: number; lng: number; visibility: string }>(
      `insert into public.places (name, area_id, location, category)
       values ('Dolores Park', $1, st_setsrid(st_makepoint(-122.4270, 37.7596), 4326), 'park')
       returning lat, lng, visibility`,
      [city],
    )
    expect(rows[0]).toEqual({ lat: 37.7596, lng: -122.427, visibility: 'public' })
    await expect(
      db.sql.query(
        `insert into public.places (name, area_id, location, visibility)
         values ('X', $1, st_setsrid(st_makepoint(0, 0), 4326), 'secret')`,
        [city],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    // Everyone reads areas and places; nobody writes them from the client.
    const guest = await createGuest(db)
    for (const as of ['visitor', guest.as] as RoleSpec[]) {
      // 0510 seeds base areas/places, so assert the fixture rows are readable rather than exact counts.
      const areas = await db.asRole(as, (c) => c.query('select id from public.areas'))
      expect(areas.rowCount).toBeGreaterThanOrEqual(5)
      const places = await db.asRole(as, (c) =>
        c.query('select lat, lng from public.places where area_id = $1', [city]),
      )
      expect(places.rowCount).toBe(1)
      await expectDenied(
        db.asRole(as, (c) =>
          c.query(
            `insert into public.areas (type, name, slug, centroid) values ('city', 'X', 'x', st_setsrid(st_makepoint(0, 0), 4326))`,
          ),
        ),
      )
      await expectDenied(db.asRole(as, (c) => c.query("update public.places set name = 'y'")))
    }
    expect(await scalar<boolean>(db, "bbox is null from public.areas where slug = 'sf'")).toBe(true)
  })
})

describe('caller helpers (0160) and me_get', () => {
  let db: TestDb
  let human: Human
  let claiming: Human
  let restricted: Human
  let guest: { userId: string; as: RoleSpec }
  let unclaimed: { userId: string; as: RoleSpec }

  const classify = (as: RoleSpec) =>
    db.rpc<{ kind: string; humanId: string | null; human: string | null }>('probe_caller', {}, as)

  beforeAll(async () => {
    db = await createTestDb()
    human = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    claiming = await createHuman(db, { handle: 'pending', status: 'pending' })
    restricted = await createHuman(db, { handle: 'restricted', status: 'restricted' })
    guest = await createGuest(db)
    unclaimed = await createUnclaimed(db)
    await db.sql.query(`
      create function public.probe_caller() returns jsonb
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select jsonb_build_object('kind', earth.current_role_kind(), 'humanId', earth.current_human_id(), 'human', earth.current_human()) $$;
      create function public.probe_assert_human() returns uuid
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.assert_human() $$;
      create function public.probe_media_url(id uuid) returns text
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.public_media_url(id) $$;
      grant execute on function public.probe_caller() to anon, authenticated;
      grant execute on function public.probe_assert_human() to anon, authenticated;
      grant execute on function public.probe_media_url(uuid) to anon, authenticated;
    `)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('current_role_kind / current_human_id / current_human per caller state (ARCHITECTURE §4)', async () => {
    expect(await classify('visitor')).toEqual({ kind: 'visitor', humanId: null, human: null })
    expect(await classify(guest.as)).toEqual({ kind: 'guest', humanId: null, human: null })
    expect(await classify(unclaimed.as)).toEqual({ kind: 'claiming', humanId: null, human: null })
    expect(await classify(claiming.as)).toEqual({
      kind: 'claiming',
      humanId: claiming.humanId,
      human: null,
    })
    expect(await classify(human.as)).toEqual({
      kind: 'human',
      humanId: human.humanId,
      human: human.humanId,
    })
    expect(await classify(restricted.as)).toEqual({
      kind: 'human',
      humanId: restricted.humanId,
      human: null,
    })
    expect(await classify('service')).toEqual({ kind: 'service', humanId: null, human: null })
  })

  it('assert_human raises the right code for every non-Human caller', async () => {
    await db.expectError(db.rpc('probe_assert_human', {}, 'visitor'), 'not_authenticated')
    await db.expectError(db.rpc('probe_assert_human', {}, guest.as), 'not_a_human')
    await db.expectError(db.rpc('probe_assert_human', {}, unclaimed.as), 'not_a_human')
    await db.expectError(db.rpc('probe_assert_human', {}, claiming.as), 'not_a_human')
    await db.expectError(db.rpc('probe_assert_human', {}, restricted.as), 'human_not_active')
    await db.expectError(db.rpc('probe_assert_human', {}, 'service'), 'not_a_human')
    expect(await db.rpc('probe_assert_human', {}, human.as)).toBe(human.humanId)
  })

  it('a Supabase auth user can never own two Humans', async () => {
    await expect(
      db.sql.query(
        `insert into public.humans (status, auth_user_id, claimed_at) values ('active', $1, now())`,
        [human.userId],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION })
  })

  it('public_media_url is null until the storage base URL is configured, avatars only', async () => {
    const { rows } = await db.sql.query<{ id: string }>(
      `insert into public.media_objects (owner_human_id, bucket, storage_key, content_type)
       values ($1, 'avatars', 'h/a.jpg', 'image/jpeg'), ($1, 'media', 'h/m.jpg', 'image/jpeg')
       returning id`,
      [human.humanId],
    )
    const [avatar, media] = rows.map((r) => r.id)
    expect(await db.rpc('probe_media_url', { id: avatar }, 'visitor')).toBeNull()
    await setSetting(
      db,
      'public_storage_base_url',
      'https://cdn.example.test/storage/v1/object/public/',
    )
    expect(await db.rpc('probe_media_url', { id: avatar }, 'visitor')).toBe(
      'https://cdn.example.test/storage/v1/object/public/avatars/h/a.jpg',
    )
    expect(await db.rpc('probe_media_url', { id: media }, 'visitor')).toBeNull()
    await setSetting(db, 'public_storage_base_url', '')
  })

  it('me_get answers every caller kind with a MeDto', async () => {
    const visitor = MeDtoSchema.parse(await db.rpc('me_get', {}, 'visitor'))
    expect(visitor).toMatchObject({
      roleKind: 'visitor',
      humanId: null,
      identity: null,
      context: null,
    })
    expect(visitor.flags['GROUP_ANCHORED_CLAIM_REQUIRED']?.enabled).toBe(true)
    expect(MeDtoSchema.parse(await db.rpc('me_get', {}, guest.as)).roleKind).toBe('guest')
    expect(MeDtoSchema.parse(await db.rpc('me_get', {}, unclaimed.as))).toMatchObject({
      roleKind: 'claiming',
      humanId: null,
      humanStatus: null,
    })
    expect(MeDtoSchema.parse(await db.rpc('me_get', {}, claiming.as))).toMatchObject({
      roleKind: 'claiming',
      humanId: claiming.humanId,
      humanStatus: 'pending',
      identity: { handle: 'pending' },
      context: null,
    })
    expect(MeDtoSchema.parse(await db.rpc('me_get', {}, human.as))).toMatchObject({
      roleKind: 'human',
      humanId: human.humanId,
      humanStatus: 'active',
      humanPassStatus: 'verified',
      identity: { handle: 'alice', displayName: 'Alice' },
      context: { currentAreaId: null, homeCityId: null },
    })
    expect(MeDtoSchema.parse(await db.rpc('me_get', {}, 'service')).roleKind).toBe('service')
  })
})

describe('handles', () => {
  let db: TestDb
  let alice: Human
  let bob: Human

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice' })
    bob = await createHuman(db, { handle: 'bob' })
  })

  afterAll(async () => {
    await db.drop()
  })

  it('handle uniqueness is case-insensitive at the index', async () => {
    await expect(
      db.sql.query(
        `insert into public.public_identities (human_id, display_name, handle)
         values ($1, 'X', 'Alice')`,
        [bob.humanId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
    // The check constraint keeps handles lowercase; bypassing it with lower() still collides.
    const spare = await createHuman(db, { handle: 'spare', identity: false })
    await expect(
      db.sql.query(
        `insert into public.public_identities (human_id, display_name, handle) values ($1, 'X', 'alice')`,
        [spare.humanId],
      ),
    ).rejects.toMatchObject({ code: UNIQUE_VIOLATION })
  })

  it('handle_available normalizes, checks case-insensitively and needs a credential', async () => {
    await db.expectError(
      db.rpc('handle_available', { handle: 'zoe' }, 'visitor'),
      'not_authenticated',
    )
    expect(await db.rpc('handle_available', { handle: 'zoe' }, bob.as)).toBe(true)
    expect(await db.rpc('handle_available', { handle: 'Alice' }, bob.as)).toBe(false)
    expect(await db.rpc('handle_available', { handle: '@ALICE ' }, bob.as)).toBe(false)
    expect(await db.rpc('handle_available', { handle: 'bob' }, bob.as)).toBe(true)
    expect(await db.rpc('handle_available', { handle: 'bob' }, alice.as)).toBe(false)
    expect(await db.rpc('handle_available', { handle: 'ab' }, bob.as)).toBe(false)
    expect(await db.rpc('handle_available', { handle: '1abc' }, bob.as)).toBe(false)
    expect(await db.rpc('handle_available', { handle: 'a'.repeat(25) }, bob.as)).toBe(false)
  })
})

describe('profile_get and identity_update', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let hidden: Human
  let blocked: Human
  let pending: Human
  let fixture: Human
  let guest: { userId: string; as: RoleSpec }
  let city: string

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice', displayName: 'Alice' })
    bob = await createHuman(db, { handle: 'bob', displayName: 'Bob' })
    await createHuman(db, { handle: 'lim', visibility: 'limited' })
    hidden = await createHuman(db, { handle: 'hid', visibility: 'hidden' })
    blocked = await createHuman(db, { handle: 'blk' })
    pending = await createHuman(db, { handle: 'pend', status: 'pending' })
    fixture = await createHuman(db, { handle: 'fixture' })
    await db.sql.query('update public.humans set is_fixture = true where id = $1', [
      fixture.humanId,
    ])
    guest = await createGuest(db)
    await befriend(db, alice, hidden)
    await block(db, alice, blocked)
    city = await createArea(db, { name: 'San Francisco', slug: 'sf', type: 'city' })
  })

  afterAll(async () => {
    await db.drop()
  })

  it('applies profile_visibility per caller kind (public / limited / hidden)', async () => {
    for (const as of ['visitor', guest.as, pending.as] as RoleSpec[]) {
      const profile = ProfileDtoSchema.parse(await db.rpc('profile_get', { handle: 'alice' }, as))
      expect(profile.identity.handle).toBe('alice')
      expect(profile.canMessage).toBe(false)
      expect(profile.relationship.isSelf).toBe(false)
      await db.expectError(db.rpc('profile_get', { handle: 'lim' }, as), 'not_visible')
      await db.expectError(db.rpc('profile_get', { handle: 'hid' }, as), 'not_visible')
    }
    // Signed-in Humans see limited profiles; hidden profiles only through friendship or self.
    expect(
      ProfileDtoSchema.parse(await db.rpc('profile_get', { handle: 'lim' }, bob.as)).identity
        .handle,
    ).toBe('lim')
    await db.expectError(db.rpc('profile_get', { handle: 'hid' }, bob.as), 'not_visible')
    expect(
      ProfileDtoSchema.parse(await db.rpc('profile_get', { handle: 'hid' }, alice.as)).relationship
        .isFriend,
    ).toBe(true)
    expect(
      ProfileDtoSchema.parse(await db.rpc('profile_get', { handle: 'hid' }, hidden.as)).relationship
        .isSelf,
    ).toBe(true)
    // Handles are matched case-insensitively.
    expect(
      ProfileDtoSchema.parse(await db.rpc('profile_get', { handle: '@Alice' }, bob.as)).identity
        .humanId,
    ).toBe(alice.humanId)
    await db.expectError(db.rpc('profile_get', { handle: 'nobody' }, bob.as), 'not_visible')
  })

  it('pending Humans are invisible to everyone but themselves; blocks hide both ways', async () => {
    await db.expectError(db.rpc('profile_get', { handle: 'pend' }, 'visitor'), 'not_visible')
    await db.expectError(db.rpc('profile_get', { handle: 'pend' }, bob.as), 'not_visible')
    expect(
      ProfileDtoSchema.parse(await db.rpc('profile_get', { handle: 'pend' }, pending.as))
        .relationship.isSelf,
    ).toBe(true)
    await db.expectError(db.rpc('profile_get', { handle: 'blk' }, alice.as), 'not_visible')
    await db.expectError(db.rpc('profile_get', { handle: 'alice' }, blocked.as), 'not_visible')
    expect(
      ProfileDtoSchema.parse(await db.rpc('profile_get', { handle: 'blk' }, bob.as)).identity
        .handle,
    ).toBe('blk')
  })

  it('hides fixture Humans from visitors only in production', async () => {
    expect(
      (
        await db.rpc<{ identity: { handle: string } }>(
          'profile_get',
          { handle: 'fixture' },
          'visitor',
        )
      ).identity.handle,
    ).toBe('fixture')
    await setSetting(db, 'environment', 'production')
    await db.expectError(db.rpc('profile_get', { handle: 'fixture' }, 'visitor'), 'not_visible')
    expect(
      (await db.rpc<{ identity: { handle: string } }>('profile_get', { handle: 'fixture' }, bob.as))
        .identity.handle,
    ).toBe('fixture')
    await setSetting(db, 'environment', 'development')
  })

  it('reports relationship flags, counts and canMessage from the viewer side', async () => {
    const own = ProfileDtoSchema.parse(await db.rpc('profile_get', { handle: 'alice' }, alice.as))
    expect(own.relationship).toEqual({
      isSelf: true,
      isFriend: false,
      friendRequest: 'none',
      isFollowing: false,
      isFollowedBy: false,
      isBlocked: false,
    })
    expect(own.counts).toEqual({ friends: 1, followers: 0, following: 0, posts: 0 })
    expect(own.canMessage).toBe(false)
    const asBob = ProfileDtoSchema.parse(await db.rpc('profile_get', { handle: 'alice' }, bob.as))
    expect(asBob.canMessage).toBe(true)
    expect(asBob.mutualFriendCount).toBe(0)
    expect(asBob.sharedGroupCount).toBe(0)
    await befriend(db, bob, hidden)
    expect(
      ProfileDtoSchema.parse(await db.rpc('profile_get', { handle: 'alice' }, bob.as))
        .mutualFriendCount,
    ).toBe(1)
  })

  it('identity_update edits own identity and validates the home city', async () => {
    await db.expectError(
      db.rpc('identity_update', { display_name: 'A' }, 'visitor'),
      'not_authenticated',
    )
    await db.expectError(
      db.rpc('identity_update', { display_name: 'A' }, pending.as),
      'not_a_human',
    )
    await db.expectError(
      db.rpc(
        'identity_update',
        { home_city_area_id: '00000000-0000-0000-0000-000000000000' },
        alice.as,
      ),
      'area_not_found',
    )
    const hood = await createArea(db, {
      name: 'Mission',
      slug: 'mission',
      type: 'neighborhood',
      parentAreaId: city,
    })
    await db.expectError(
      db.rpc('identity_update', { home_city_area_id: hood }, alice.as),
      'invalid_input',
    )
    await db.expectError(
      db.rpc('identity_update', { display_name: ' ' }, alice.as),
      'invalid_input',
    )
    await db.expectError(
      db.rpc('identity_update', { bio: 'x'.repeat(281) }, alice.as),
      'invalid_input',
    )

    const updated = PublicIdentityDtoSchema.parse(
      await db.rpc(
        'identity_update',
        {
          display_name: 'Alice A.',
          bio: 'hello',
          profile_visibility: 'limited',
          public_city_visibility: true,
          home_city_area_id: city,
        },
        alice.as,
      ),
    )
    expect(updated).toMatchObject({
      humanId: alice.humanId,
      displayName: 'Alice A.',
      handle: 'alice',
      bio: 'hello',
      cityName: 'San Francisco',
      profileVisibility: 'limited',
    })
    // Null arguments leave fields unchanged; an empty bio clears it; the context mirrors home city.
    const again = PublicIdentityDtoSchema.parse(
      await db.rpc('identity_update', { bio: '' }, alice.as),
    )
    expect(again).toMatchObject({ displayName: 'Alice A.', bio: null, cityName: 'San Francisco' })
    expect(
      await scalar<string | null>(
        db,
        'home_city_id from public.human_context where human_id = $1',
        [alice.humanId],
      ),
    ).toBe(city)
    await db.rpc('identity_update', { profile_visibility: 'public' }, alice.as)
  })

  it('RLS lets a Human edit own identity columns directly, never the handle or others', async () => {
    const own = await db.asRole(alice.as, (c) =>
      c.query("update public.public_identities set bio = 'direct' where human_id = $1", [
        alice.humanId,
      ]),
    )
    expect(own.rowCount).toBe(1)
    const other = await db.asRole(bob.as, (c) =>
      c.query("update public.public_identities set bio = 'nope' where human_id = $1", [
        alice.humanId,
      ]),
    )
    expect(other.rowCount).toBe(0)
    await expectDenied(
      db.asRole(alice.as, (c) =>
        c.query("update public.public_identities set handle = 'alice2' where human_id = $1", [
          alice.humanId,
        ]),
      ),
    )
    // A pending Human edits their own (claim step) row too.
    const pendingEdit = await db.asRole(pending.as, (c) =>
      c.query("update public.public_identities set display_name = 'P' where human_id = $1", [
        pending.humanId,
      ]),
    )
    expect(pendingEdit.rowCount).toBe(1)
  })
})
