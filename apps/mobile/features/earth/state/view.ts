/**
 * Camera decisions for SCREEN 20, pure so they are tested without a map: where each radius
 * starts, how a bounding box becomes a stable query key, how a react-native-maps `Region`
 * relates to a viewport (center + zoom), and the light map style for Google on Android.
 * Nothing here imports the vendor: a region is described by four numbers.
 */
import type { BoundingBox, LatLngDto, Scope } from '@earth/domain'

export type LatLng = LatLngDto
/** `[west, south, east, north]` in degrees — the same tuple `earth.map.objects` takes. */
export type MapBounds = BoundingBox

export interface MapViewport {
  readonly center: LatLng
  readonly zoom: number
}

export interface MapMoveState extends MapViewport {
  readonly bounds: MapBounds
}

/** A map region as the native map reports it (center plus spans), vendor-free. */
export interface MapRegion {
  readonly latitude: number
  readonly longitude: number
  readonly latitudeDelta: number
  readonly longitudeDelta: number
}

/** Zoomed-out globe: "Humans are Live around Earth" (SCREEN 20 World). */
export const WORLD_VIEW: MapViewport = { center: { lat: 20, lng: 0 }, zoom: 1.4 }

/** Zoom levels per radius when a city centroid is known (spec §52). */
export const SCOPE_ZOOM = {
  friends: 11,
  neighborhood: 13,
  city: 11,
  world: WORLD_VIEW.zoom,
} as const satisfies Record<Scope, number>

/** A Place the map is asked to open on (`/earth?place=…`). */
export const PLACE_ZOOM = 15

/** Own position after "Use my location". */
export const LOCATE_ZOOM = 13

/** The camera never zooms in past street level. */
export const MAP_MAX_ZOOM = 17
export const MAP_MIN_ZOOM = 1

/** Portrait phone: the visible latitude span is this much taller than the longitude span. */
export const DEFAULT_ASPECT = 1.6

/** Neighborhood and City need a city to start from; World never does. */
export function viewForScope(scope: Scope, city: LatLng | null): MapViewport {
  if (scope === 'world' || city === null) return WORLD_VIEW
  return { center: city, zoom: SCOPE_ZOOM[scope] }
}

/** Degrees kept in the query key: 3 decimals ≈ 100 m, enough to stop jitter re-fetches. */
export const BBOX_KEY_DECIMALS = 3

export function roundBounds(bounds: MapBounds): MapBounds {
  const factor = 10 ** BBOX_KEY_DECIMALS
  const round = (value: number): number => Math.round(value * factor) / factor
  const west = round(bounds[0])
  const south = round(bounds[1])
  const east = round(bounds[2])
  const north = round(bounds[3])
  return [
    Math.min(west, east),
    Math.min(south, north),
    Math.max(west, east),
    Math.max(south, north),
  ]
}

/** Longitudes wrap around the antimeridian; a world view can report a box wider than the globe. */
export function clampBounds(bounds: MapBounds): MapBounds {
  const clampLng = (value: number): number => Math.max(-180, Math.min(180, value))
  const clampLat = (value: number): number => Math.max(-90, Math.min(90, value))
  return [clampLng(bounds[0]), clampLat(bounds[1]), clampLng(bounds[2]), clampLat(bounds[3])]
}

/** Stable, comparable key for a box (react-query key member). */
export function boundsKey(bounds: MapBounds): string {
  return roundBounds(clampBounds(bounds)).join(',')
}

/** The box that contains every position, padded so single points still make a box. */
export function boundsAround(positions: readonly LatLng[], padDegrees = 0.002): MapBounds | null {
  if (positions.length === 0) return null
  let west = 180
  let south = 90
  let east = -180
  let north = -90
  for (const p of positions) {
    west = Math.min(west, p.lng)
    east = Math.max(east, p.lng)
    south = Math.min(south, p.lat)
    north = Math.max(north, p.lat)
  }
  return clampBounds([west - padDegrees, south - padDegrees, east + padDegrees, north + padDegrees])
}

/** Milliseconds the camera must rest before objects are fetched for the new box. */
export const MOVE_DEBOUNCE_MS = 300

// ---------------------------------------------------------------------------
// Region ↔ viewport
// ---------------------------------------------------------------------------

/** Web-mercator style zoom from the visible longitude span: zoom 0 shows the whole globe. */
export function zoomForRegion(region: Pick<MapRegion, 'longitudeDelta'>): number {
  const span = Math.max(1e-6, Math.min(360, region.longitudeDelta))
  return Math.max(0, Math.log2(360 / span))
}

/** The region a viewport stands for; `aspect` is visible height / width. */
export function regionForView(view: MapViewport, aspect: number = DEFAULT_ASPECT): MapRegion {
  const zoom = Math.max(MAP_MIN_ZOOM - 1, Math.min(MAP_MAX_ZOOM, view.zoom))
  const longitudeDelta = Math.min(360, 360 / 2 ** zoom)
  const latitudeDelta = Math.min(170, longitudeDelta * Math.max(0.2, aspect))
  return {
    latitude: view.center.lat,
    longitude: view.center.lng,
    latitudeDelta,
    longitudeDelta,
  }
}

export function boundsForRegion(region: MapRegion): MapBounds {
  return clampBounds([
    region.longitude - region.longitudeDelta / 2,
    region.latitude - region.latitudeDelta / 2,
    region.longitude + region.longitudeDelta / 2,
    region.latitude + region.latitudeDelta / 2,
  ])
}

export function moveStateForRegion(region: MapRegion): MapMoveState {
  return {
    center: { lat: region.latitude, lng: region.longitude },
    zoom: zoomForRegion(region),
    bounds: boundsForRegion(region),
  }
}

// ---------------------------------------------------------------------------
// Light style
// ---------------------------------------------------------------------------

export interface MapStyleRule {
  readonly featureType?: string
  readonly elementType?: string
  readonly stylers: readonly Record<string, string | number>[]
}

/**
 * The white/light Earth design (SCREEN 20, spec §89) as a Google map style for Android: pale
 * land, quiet water, no points of interest, muted labels. Apple Maps on iOS uses the platform's
 * muted standard style instead (no custom styling exists there). Colours are the spec palette.
 */
export function lightMapStyle(palette: {
  readonly background: string
  readonly subtleFill: string
  readonly separator: string
  readonly textSecondary: string
}): readonly MapStyleRule[] {
  return [
    { elementType: 'geometry', stylers: [{ color: palette.background }] },
    { elementType: 'labels.text.fill', stylers: [{ color: palette.textSecondary }] },
    { elementType: 'labels.text.stroke', stylers: [{ color: palette.background }] },
    { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'poi', stylers: [{ visibility: 'off' }] },
    { featureType: 'transit', stylers: [{ visibility: 'off' }] },
    { featureType: 'administrative', elementType: 'geometry', stylers: [{ visibility: 'off' }] },
    { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: palette.background }] },
    { featureType: 'road', elementType: 'geometry', stylers: [{ color: palette.subtleFill }] },
    { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ visibility: 'off' }] },
    { featureType: 'road', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
    { featureType: 'water', elementType: 'geometry', stylers: [{ color: palette.separator }] },
    {
      featureType: 'water',
      elementType: 'labels.text.fill',
      stylers: [{ color: palette.textSecondary }],
    },
  ]
}
