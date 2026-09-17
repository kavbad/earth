/**
 * The basemap the app serves itself (`GET /map-style.json`, SCREEN 20): Earth's land as
 * silhouettes, so the map is never a blank surface, from data that ships with the app.
 *
 * Land is Natural Earth's 110 m coastline (`world-atlas`, public domain), decoded from TopoJSON
 * once per process and rounded to three decimals (≈ 110 m, the data's own resolution) with the
 * vertices that rounding makes coincident dropped. One thing the atlas leaves to the renderer is
 * done here because MapLibre's tiler does not do it: a ring that crosses the antimeridian
 * is unwrapped so no segment spans the globe (Chukotka and Fiji otherwise paint a band across
 * every tile). That is a globe's resolution, not a street's: the land fades into the uniform surface between `LAND_FADE_FROM_ZOOM` and
 * `LAND_MAX_ZOOM`, so at city and neighborhood zoom the map is the same quiet stone it always
 * was and a 110 m coast never puts a neighborhood in the sea. A faint graticule keeps the
 * globe legible when the whole Earth is in view. Everything is inline: no tiles, no host.
 */
import { colors } from '@earth/ui'
import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  MultiPolygon,
  Position,
} from 'geojson'
import { feature } from 'topojson-client'
import type { GeometryObject, Topology } from 'topojson-specification'
import land110m from 'world-atlas/land-110m.json'

/** Coordinates kept to this many decimals: 0.001° ≈ 110 m, the data's own resolution. */
export const LAND_PRECISION = 3
/** Meridians and parallels every ten degrees, parallels to ±80° (Mercator's useful extent). */
export const GRATICULE_STEP_DEG = 10
export const GRATICULE_LAT_LIMIT_DEG = 80
/** Land and coast fade out over this zoom range; above it only the surface remains. */
export const LAND_FADE_FROM_ZOOM = 6
export const LAND_MAX_ZOOM = 8
/**
 * Antarctica's ring runs back along its polar edge (the atlas draws it at −84.7°) from 180 to
 * −180: that edge is the polygon's own boundary, not a jump to undo.
 */
export const POLE_EDGE_LAT = 84
/** Line widths in CSS px. */
export const COAST_WIDTH_PX = 0.75
export const GRATICULE_WIDTH_PX = 0.5
export const GRATICULE_OPACITY = 0.6
/** The serialized style must stay one cheap, cacheable request. */
export const BASEMAP_BUDGET_BYTES = 300_000

export interface BasemapLayer {
  readonly id: string
  readonly type: 'background' | 'fill' | 'line'
  readonly source?: string
  readonly maxzoom?: number
  readonly paint: Record<string, unknown>
}

export interface BasemapStyle {
  readonly version: 8
  readonly name: string
  readonly sources: Record<string, { readonly type: 'geojson'; readonly data: unknown }>
  readonly layers: readonly BasemapLayer[]
  readonly metadata: Record<string, unknown>
}

const factor = 10 ** LAND_PRECISION
const round = (value: number): number => Math.round(value * factor) / factor

/** A ring needs a closing point and three distinct corners to be a polygon at all. */
const MIN_RING_POINTS = 4

/**
 * Longitudes continued past ±180 wherever the ring jumps across the antimeridian, so consecutive
 * points are never more than half the world apart; MapLibre draws the overflow on the next copy.
 */
function unwrapRing(ring: Position[]): Position[] {
  let offset = 0
  let previous: number | null = null
  return ring.map(([lng, lat]) => {
    const raw = lng ?? 0
    const y = lat ?? 0
    if (previous !== null && Math.abs(y) < POLE_EDGE_LAT) {
      if (raw - previous > 180) offset -= 360
      else if (raw - previous < -180) offset += 360
    }
    previous = raw
    return [raw + offset, y]
  })
}

function roundRing(ring: Position[]): Position[] {
  const out: Position[] = []
  for (const [lng, lat] of unwrapRing(ring)) {
    const point: Position = [round(lng ?? 0), round(lat ?? 0)]
    const last = out[out.length - 1]
    if (last !== undefined && last[0] === point[0] && last[1] === point[1]) continue
    out.push(point)
  }
  // Rounding can pull the closing point onto the first; close the ring again.
  const first = out[0]
  const last = out[out.length - 1]
  if (first !== undefined && last !== undefined && (first[0] !== last[0] || first[1] !== last[1])) {
    out.push([first[0] ?? 0, first[1] ?? 0])
  }
  return out
}

/**
 * The atlas's polygon structure is kept — an outer ring and its holes (the Caspian is one) —
 * with every ring unwrapped, rounded and closed.
 */
function roundRings(polygons: Position[][][]): Position[][][] {
  return polygons
    .map((rings) => rings.map(roundRing).filter((ring) => ring.length >= MIN_RING_POINTS))
    .filter((rings) => rings.length > 0)
}

/** Every polygon of a decoded geometry, whatever shape the atlas encodes it as. */
function polygonsOf(geometry: Geometry): Position[][][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(polygonsOf)
  return []
}

let landCache: Feature<MultiPolygon> | null = null

/** Earth's land, one MultiPolygon, decoded once and rounded to `LAND_PRECISION`. */
export function landGeoJson(): Feature<MultiPolygon> {
  if (landCache !== null) return landCache
  const topology = land110m as unknown as Topology<{ land: GeometryObject }>
  const decoded = feature(topology, topology.objects.land)
  const polygons =
    decoded.type === 'FeatureCollection'
      ? decoded.features.flatMap((item) => polygonsOf(item.geometry))
      : polygonsOf(decoded.geometry)
  landCache = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'MultiPolygon', coordinates: roundRings(polygons) },
  }
  return landCache
}

/** Meridians and parallels as two-point lines (straight in Mercator, so two points suffice). */
export function graticule(
  step: number = GRATICULE_STEP_DEG,
  latLimit: number = GRATICULE_LAT_LIMIT_DEG,
): FeatureCollection<LineString> {
  const features: Feature<LineString>[] = []
  for (let lng = -180; lng <= 180; lng += step) {
    features.push(line([lng, -latLimit], [lng, latLimit]))
  }
  for (let lat = -latLimit; lat <= latLimit; lat += step) {
    features.push(line([-180, lat], [180, lat]))
  }
  return { type: 'FeatureCollection', features }
}

function line(from: Position, to: Position): Feature<LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [from, to] },
  }
}

/** `[zoom → value]` pairs as a MapLibre zoom interpolation. */
function fadeOut<T extends number | string>(atFull: T, atNone: T): unknown {
  return ['interpolate', ['linear'], ['zoom'], LAND_FADE_FROM_ZOOM, atFull, LAND_MAX_ZOOM, atNone]
}

export function basemapStyle(): BasemapStyle {
  return {
    version: 8,
    name: 'earth-basemap',
    sources: {
      land: { type: 'geojson', data: landGeoJson() },
      graticule: { type: 'geojson', data: graticule() },
    },
    layers: [
      // Water is the page; past the fade the whole surface is the stone the land was.
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': fadeOut(colors.background, colors.subtleFill) },
      },
      {
        id: 'land',
        type: 'fill',
        source: 'land',
        paint: { 'fill-color': colors.subtleFill, 'fill-opacity': fadeOut(1, 0) },
      },
      {
        id: 'coast',
        type: 'line',
        source: 'land',
        maxzoom: LAND_MAX_ZOOM,
        paint: {
          'line-color': colors.separator,
          'line-width': COAST_WIDTH_PX,
          'line-opacity': fadeOut(1, 0),
        },
      },
      {
        id: 'graticule',
        type: 'line',
        source: 'graticule',
        maxzoom: LAND_MAX_ZOOM,
        paint: {
          'line-color': colors.separator,
          'line-width': GRATICULE_WIDTH_PX,
          'line-opacity': fadeOut(GRATICULE_OPACITY, 0),
        },
      },
    ],
    metadata: {
      'earth:basemap': 'land-110m',
      'earth:surface': colors.background,
      'earth:fallback': true,
    },
  }
}
