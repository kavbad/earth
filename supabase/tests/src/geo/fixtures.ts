/**
 * Shared fixtures for the areas / places / location-sharing database tests (Milestone 6). Base
 * areas come from migration 0510 (looked up by slug); shares go through the RPCs of 0530. Re-exports
 * the admission and rooms fixtures these tests build on.
 */
import { LocationShareDtoSchema, MapFriendDtoSchema, type LocationShareDto } from '@earth/domain'
import { z } from 'zod'

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
export { human, joinRoom, rpcAt, setContext, startStandaloneRoom } from '../rooms/fixtures'

export const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/** Slugs of the production-safe base rows (0510_areas_base.sql). */
export const BASE_AREA_SLUGS = {
  unitedStates: 'usa',
  california: 'usa-ca',
  newYorkState: 'usa-ny',
  sanFrancisco: 'usa-ca-san-francisco',
  oakland: 'usa-ca-oakland',
  losAngeles: 'usa-ca-los-angeles',
  newYork: 'usa-ny-new-york',
  northBeach: 'usa-ca-san-francisco-north-beach',
  mission: 'usa-ca-san-francisco-mission',
  doloresHeights: 'usa-ca-san-francisco-dolores-heights',
  hayesValley: 'usa-ca-san-francisco-hayes-valley',
  soma: 'usa-ca-san-francisco-soma',
  marina: 'usa-ca-san-francisco-marina',
} as const

/** Base place keys (`places.provider_reference = 'earth:<key>'`). */
export const BASE_PLACE_KEYS = ['dolores-park', 'washington-square-park', 'ferry-building'] as const

/** Real coordinates used by the tests (none of them equals a seeded centroid or place). */
export const POINTS = {
  /** Inside the North Beach polygon (Columbus Ave / Union St). */
  northBeach: { lat: 37.80123, lng: -122.41234 },
  /** Inside San Francisco but outside every seeded neighborhood (Golden Gate Park). */
  goldenGatePark: { lat: 37.76946, lng: -122.48631 },
  /**
   * Probe positions only ever passed to area_resolve / context_resolve_and_set (never to a
   * place or a share), so their digits must not appear in any row afterwards.
   */
  northBeachProbe: { lat: 37.80456, lng: -122.41567 },
  parkProbe: { lat: 37.77123, lng: -122.49234 },
  /** Inside the Mission polygon. */
  mission: { lat: 37.75871, lng: -122.41453 },
  /** Gulf of Guinea: no area at all. */
  ocean: { lat: 0.12345, lng: 0.54321 },
  /** Inside the Oakland city polygon, outside every base neighborhood. */
  oakland: { lat: 37.80432, lng: -122.27123 },
} as const

/** Centroid of the San Francisco base row (0510). */
export const SF_CENTROID = { lat: 37.7749, lng: -122.4194 } as const

export interface LatLng {
  lat: number
  lng: number
}

/** Rounds to `decimals` places the way `earth.geo_snap` does (half away from zero). */
export function snapTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  const scaled = value * factor
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled))
  return Number((rounded / factor).toFixed(decimals))
}

/** The position a recipient of a share with this precision sees for a device position. */
export function expectedPosition(
  precision: 'precise' | 'approximate' | 'city',
  position: LatLng,
  cityCentroid: LatLng | null,
): LatLng {
  if (precision === 'precise') return position
  if (precision === 'approximate')
    return { lat: snapTo(position.lat, 2), lng: snapTo(position.lng, 2) }
  return cityCentroid ?? { lat: snapTo(position.lat, 1), lng: snapTo(position.lng, 1) }
}

export async function areaBySlug(db: TestDb, slug: string): Promise<string> {
  const { rows } = await db.sql.query<{ id: string }>(
    'select id from public.areas where slug = $1',
    [slug],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error(`area ${slug} missing`)
  return id
}

export async function placeByKey(db: TestDb, key: string): Promise<string> {
  const { rows } = await db.sql.query<{ id: string }>(
    'select id from public.places where provider_reference = $1',
    [`earth:${key}`],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error(`place ${key} missing`)
  return id
}

export interface ShareOptions {
  audienceType?: 'friend' | 'group' | 'temporary_context'
  audienceId: string
  precision?: 'precise' | 'approximate' | 'city'
  durationSeconds?: number
  position?: LatLng
}

export function shareArgs(options: ShareOptions): Record<string, unknown> {
  const position = options.position ?? POINTS.northBeach
  return {
    audience_type: options.audienceType ?? 'friend',
    audience_id: options.audienceId,
    precision: options.precision ?? 'precise',
    duration_seconds: options.durationSeconds ?? 3600,
    lat: position.lat,
    lng: position.lng,
  }
}

/** `location_share_create` as `sharer`, parsed as `LocationShareDto`. */
export async function createShare(
  db: TestDb,
  sharer: Human,
  options: ShareOptions,
): Promise<LocationShareDto> {
  return LocationShareDtoSchema.parse(
    await db.rpc('location_share_create', shareArgs(options), sharer.as),
  )
}

/** What `location_shares_visible()` returns: MapFriendDto plus the share reference. */
export const VisibleShareSchema = MapFriendDtoSchema.extend({
  shareId: z.uuid(),
  audienceType: z.enum(['friend', 'group', 'temporary_context']),
  audienceId: z.uuid(),
  updatedAt: z.iso.datetime({ offset: true }),
})
export type VisibleShare = z.infer<typeof VisibleShareSchema>

export async function visibleShares(db: TestDb, as: RoleSpec): Promise<VisibleShare[]> {
  return z.array(VisibleShareSchema).parse(await db.rpc('location_shares_visible', {}, as))
}

export async function shareRow(
  db: TestDb,
  shareId: string,
): Promise<{ revoked_at: string | null; expires_at: string; precision: string } | null> {
  const { rows } = await db.sql.query<{
    revoked_at: string | null
    expires_at: string
    precision: string
  }>('select revoked_at, expires_at, precision::text from public.location_shares where id = $1', [
    shareId,
  ])
  return rows[0] ?? null
}

/** The stored (already degraded) position of a share, or null when no row exists. */
export async function storedPosition(
  db: TestDb,
  shareId: string,
): Promise<{ lat: number; lng: number; cityAreaId: string | null } | null> {
  const { rows } = await db.sql.query<{ lat: number; lng: number; city_area_id: string | null }>(
    `select st_y(location) as lat, st_x(location) as lng, city_area_id
       from public.location_share_positions where share_id = $1`,
    [shareId],
  )
  const row = rows[0]
  return row === undefined ? null : { lat: row.lat, lng: row.lng, cityAreaId: row.city_area_id }
}

export async function contextRow(
  db: TestDb,
  human: Human,
): Promise<{
  current_area_id: string | null
  current_city_id: string | null
  home_city_id: string | null
} | null> {
  const { rows } = await db.sql.query<{
    current_area_id: string | null
    current_city_id: string | null
    home_city_id: string | null
  }>(
    'select current_area_id, current_city_id, home_city_id from public.human_context where human_id = $1',
    [human.humanId],
  )
  return rows[0] ?? null
}

interface CoordinateColumn {
  schema: string
  table: string
  column: string
}

/** Every geometry / floating-point / numeric column of the public and private schemas. */
export async function coordinateColumns(db: TestDb): Promise<CoordinateColumn[]> {
  const { rows } = await db.sql.query<{
    table_schema: string
    table_name: string
    column_name: string
  }>(
    `select c.table_schema, c.table_name, c.column_name
       from information_schema.columns c
       join information_schema.tables t
         on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
      where c.table_schema in ('public', 'private')
        and (c.data_type in ('double precision', 'real', 'numeric') or c.udt_name = 'geometry')
      order by 1, 2, 3`,
  )
  return rows.map((row) => ({
    schema: row.table_schema,
    table: row.table_name,
    column: row.column_name,
  }))
}

/** A digest of every value in every coordinate-typed column: unchanged means nothing geographic was written. */
export async function coordinateDigest(db: TestDb): Promise<Record<string, string>> {
  const digest: Record<string, string> = {}
  for (const { schema, table, column } of await coordinateColumns(db)) {
    const { rows } = await db.sql.query<{ digest: string; n: string }>(
      `select md5(coalesce(string_agg("${column}"::text, ',' order by "${column}"::text), '')) as digest, count(*)::text as n
         from "${schema}"."${table}"`,
    )
    digest[`${schema}.${table}.${column}`] = `${rows[0]?.n}:${rows[0]?.digest}`
  }
  return digest
}

/**
 * Tables whose rows, rendered as text, contain any of the given coordinate fragments as a number
 * (not as the tail of a longer number or of a timestamp's seconds).
 */
export async function tablesMentioning(
  db: TestDb,
  fragments: readonly string[],
): Promise<string[]> {
  const patterns = fragments.map((fragment) => `(^|[^0-9:.])${fragment.replace(/\./g, '\\.')}`)
  const { rows: tables } = await db.sql.query<{ table_schema: string; table_name: string }>(
    `select table_schema, table_name from information_schema.tables
      where table_schema in ('public', 'private') and table_type = 'BASE TABLE' order by 1, 2`,
  )
  const hits: string[] = []
  for (const { table_schema, table_name } of tables) {
    const { rows } = await db.sql.query<{ n: string }>(
      `select count(*)::text as n from "${table_schema}"."${table_name}" t
        where exists (select 1 from unnest($1::text[]) f where t::text ~ f)`,
      [patterns],
    )
    if (Number(rows[0]?.n ?? '0') > 0) hits.push(`${table_schema}.${table_name}`)
  }
  return hits
}
