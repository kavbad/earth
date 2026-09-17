/**
 * Property guard (EARTH_V1_SPEC.md §96: "Do not attach exact GPS to general analytics events").
 *
 * Two independent checks, both applied at `track()` (`./client.ts`) and again at the ingest edge
 * (`./ingest.ts`):
 *
 * 1. **Key check.** A key is forbidden when any of its word tokens (split on `_`, `-`, `.`, spaces,
 *    camelCase boundaries and letter/digit boundaries, lower-cased) is a coordinate word
 *    (`lat`, `lng`, `lon`, `latitude`, `longitude`, `latlng`, `coords`, `gps`, `geohash`, …).
 *    So `userLat`, `start_lng`, `lat1`, `latLng` and `coords` are rejected while
 *    `deliveryLatencyMs` (`latency`), `platform` and `position` pass.
 * 2. **Value check.** A string value that reads as a coordinate pair (`"37.7749,-122.4194"`,
 *    `"geo:37.7749,-122.4194"`) is forbidden whatever its key is called. The contract carries no
 *    free text (ids, enums, counts, booleans, durations only), so this cannot misfire on a
 *    legitimate value.
 *
 * Nested plain objects and arrays are scanned recursively (the wire format rejects nested objects
 * outright, but vendor providers receive the merged object as-is, so the guard must see through
 * whatever an untyped caller hands in).
 */

export const FORBIDDEN_PROPERTY_TOKENS = [
  'lat',
  'lng',
  'lon',
  'latitude',
  'longitude',
  'latlng',
  'latlon',
  'lnglat',
  'lonlat',
  'coord',
  'coords',
  'coordinate',
  'coordinates',
  'gps',
  'geo',
  'geohash',
  'geolocation',
  'geopoint',
  'geometry',
  'altitude',
] as const
export type ForbiddenPropertyToken = (typeof FORBIDDEN_PROPERTY_TOKENS)[number]

const FORBIDDEN_TOKEN_SET: ReadonlySet<string> = new Set<string>(FORBIDDEN_PROPERTY_TOKENS)

function tokensOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase())
}

export function isForbiddenPropertyKey(key: string): boolean {
  return tokensOf(key).some((token) => FORBIDDEN_TOKEN_SET.has(token))
}

/**
 * `lat,lng` pairs with at least three decimals each (street-level precision or better), optionally
 * prefixed by the `geo:` URI scheme. Integers and low-precision values never match: area centroids
 * and radii are not exact GPS.
 */
const COORDINATE_PAIR_REGEX =
  /^\s*(?:geo:)?\s*([-+]?\d{1,3}\.\d{3,})\s*,\s*([-+]?\d{1,3}\.\d{3,})\s*$/

/** True for a string that reads as an exact latitude/longitude pair. */
export function isCoordinateLikeValue(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const match = COORDINATE_PAIR_REGEX.exec(value)
  if (match === null) return false
  const first = Number(match[1])
  const second = Number(match[2])
  // Either order (lat,lng or lng,lat); both must be within a valid coordinate range.
  const latLng = Math.abs(first) <= 90 && Math.abs(second) <= 180
  const lngLat = Math.abs(first) <= 180 && Math.abs(second) <= 90
  return latLng || lngLat
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

function isForbiddenLeaf(value: unknown): boolean {
  if (isCoordinateLikeValue(value)) return true
  return Array.isArray(value) && value.some((item) => isCoordinateLikeValue(item))
}

/**
 * Dotted paths of every forbidden property found in `properties`: keys naming a coordinate, and
 * keys whose value reads as a coordinate pair. Nested objects contribute `parent.child` paths,
 * arrays of objects `parent[index].child`. Order is document order (deterministic).
 */
export function findForbiddenPropertyKeys(properties: Readonly<Record<string, unknown>>): string[] {
  const found: string[] = []
  const visitValue = (child: unknown, path: string): void => {
    if (isPlainObject(child)) {
      visitObject(child, path)
      return
    }
    if (Array.isArray(child)) {
      child.forEach((item, index) => {
        if (isPlainObject(item)) visitObject(item, `${path}[${index}]`)
      })
    }
  }
  const visitObject = (value: Record<string, unknown>, prefix: string): void => {
    for (const [key, child] of Object.entries(value)) {
      const path = prefix === '' ? key : `${prefix}.${key}`
      if (isForbiddenPropertyKey(key) || isForbiddenLeaf(child)) {
        found.push(path)
        continue
      }
      visitValue(child, path)
    }
  }
  visitObject(properties, '')
  return found
}

/**
 * A copy of `properties` without forbidden keys and coordinate-like values. Nested objects and
 * arrays of objects are copied and cleaned too; the input is never mutated.
 */
export function stripForbiddenProperties<T extends Readonly<Record<string, unknown>>>(
  properties: T,
): T {
  const cleanValue = (child: unknown): unknown => {
    if (isPlainObject(child)) return cleanObject(child)
    if (Array.isArray(child)) return child.map((item) => cleanValue(item))
    return child
  }
  const cleanObject = (value: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (isForbiddenPropertyKey(key) || isForbiddenLeaf(child)) continue
      out[key] = cleanValue(child)
    }
    return out
  }
  return cleanObject(properties) as T
}
