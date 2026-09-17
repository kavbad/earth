/**
 * Shared fixtures for the Earth map / search database tests (SCREEN 20–21; DB_API §5 `map_objects`,
 * §9 `search`). Builds on the admission, rooms, posts and geo fixtures; the RPCs under test are
 * called through `mapObjects` / `search`, which parse the results with the domain DTO schemas.
 */
import {
  MapObjectsDtoSchema,
  SearchResultsDtoSchema,
  type MapObjectsDto,
  type SearchResultsDto,
} from '@earth/domain'

import type { RoleSpec, TestDb } from '../harness'
import type { Human } from '../admission/fixtures'

export {
  addMember,
  befriend,
  block,
  count,
  createArea,
  createGroup,
  createGuest,
  createHuman,
  createUnclaimed,
  relate,
  scalar,
  setFlag,
  setSetting,
  type GroupFixture,
  type Human,
} from '../admission/fixtures'
export {
  getRoom,
  human,
  joinRoom,
  roomRow,
  rpcAt,
  setContext,
  startGroupRoom,
  startStandaloneRoom,
} from '../rooms/fixtures'
export { createPlace, createPost, resetRateLimits, setHuman } from '../posts/fixtures'
export {
  BASE_AREA_SLUGS,
  NIL_UUID,
  POINTS,
  SF_CENTROID,
  areaBySlug,
  createShare,
  expectedPosition,
  placeByKey,
  snapTo,
  type LatLng,
} from '../geo/fixtures'

/** Base row centroids and Place positions (0510_areas_base.sql). */
export const MISSION_CENTROID = { lat: 37.7599, lng: -122.4148 } as const
export const DOLORES_PARK = { lat: 37.7596, lng: -122.427 } as const
export const WASHINGTON_SQUARE = { lat: 37.8009, lng: -122.4103 } as const

export interface Bbox {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

/** The whole San Francisco base polygon (and a bit more). */
export const SF_BBOX: Bbox = { minLat: 37.6, minLng: -122.6, maxLat: 37.9, maxLng: -122.2 }
/** Only the Mission / Dolores Park corner of the city: excludes the city centroid and North Beach. */
export const MISSION_BBOX: Bbox = {
  minLat: 37.745,
  minLng: -122.445,
  maxLat: 37.771,
  maxLng: -122.4,
}
/** North Beach only: excludes the city centroid, the Mission and Dolores Park. */
export const NORTH_BEACH_BBOX: Bbox = {
  minLat: 37.795,
  minLng: -122.42,
  maxLat: 37.81,
  maxLng: -122.4,
}
/** Nothing of Earth's base geography is in here. */
export const OCEAN_BBOX: Bbox = { minLat: -1, minLng: -1, maxLat: 1, maxLng: 1 }

export function bboxArgs(scope: string, bbox: Bbox): Record<string, unknown> {
  return {
    scope,
    min_lat: bbox.minLat,
    min_lng: bbox.minLng,
    max_lat: bbox.maxLat,
    max_lng: bbox.maxLng,
  }
}

/** `map_objects` as the caller, parsed as `MapObjectsDto`. */
export async function mapObjects(
  db: TestDb,
  scope: string,
  bbox: Bbox,
  as: RoleSpec,
): Promise<MapObjectsDto> {
  return MapObjectsDtoSchema.parse(await db.rpc('map_objects', bboxArgs(scope, bbox), as))
}

/** `search(q, limit)` as the caller, parsed as `SearchResultsDto`. */
export async function search(
  db: TestDb,
  q: string,
  as: RoleSpec,
  limit: number | null = null,
): Promise<SearchResultsDto> {
  return SearchResultsDtoSchema.parse(await db.rpc('search', { q, limit }, as))
}

/** Widens a room the moderator started; the caller must be its only publisher for it to apply. */
export async function openUp(
  db: TestDb,
  roomId: string,
  moderator: Human,
  visibility: 'friends' | 'extended' | 'neighborhood' | 'city' | 'world',
): Promise<void> {
  const change = await db.rpc<{ applied: boolean }>(
    'room_set_visibility',
    { room_id: roomId, visibility },
    moderator.as,
  )
  if (!change.applied) throw new Error(`opening up to ${visibility} did not apply`)
}

/** Attaches a public Place to a room (spec §76) or clears it. */
export async function setRoomPlace(
  db: TestDb,
  roomId: string,
  placeId: string | null,
): Promise<void> {
  await db.sql.query('update public.rooms set place_id = $2 where id = $1', [roomId, placeId])
}

export async function endRoom(db: TestDb, roomId: string, moderator: Human): Promise<void> {
  await db.rpc('room_end', { room_id: roomId }, moderator.as)
}

/** Sets the public home city of a Human's identity (SCREEN 22 "city if shared"). */
export async function setHomeCity(
  db: TestDb,
  human: Human,
  cityId: string | null,
  visible: boolean,
): Promise<void> {
  await db.sql.query(
    'update public.public_identities set home_city_area_id = $2, public_city_visibility = $3 where human_id = $1',
    [human.humanId, cityId, visible],
  )
}

export async function setGroupStatus(
  db: TestDb,
  groupId: string,
  status: 'active' | 'archived' | 'deleted',
): Promise<void> {
  await db.sql.query('update public.groups set status = $2 where id = $1', [groupId, status])
}

/** A private Place created by `owner` (only seeds and tooling make private Places). */
export async function createPrivatePlace(
  db: TestDb,
  owner: Human,
  areaId: string,
  name: string,
): Promise<string> {
  const { rows } = await db.sql.query<{ id: string }>(
    `insert into public.places (name, area_id, location, visibility, created_by_human_id)
     values ($1, $2, st_setsrid(st_makepoint(-122.41, 37.76), 4326), 'private', $3) returning id`,
    [name, areaId, owner.humanId],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('places insert returned no id')
  return id
}

export async function setPlaceFixture(
  db: TestDb,
  placeId: string,
  isFixture: boolean,
): Promise<void> {
  await db.sql.query('update public.places set is_fixture = $2 where id = $1', [placeId, isFixture])
}
