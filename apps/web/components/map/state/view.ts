/**
 * Camera decisions for SCREEN 20, pure so they are tested without a map: where each radius
 * starts, how a bounding box becomes a stable query key, and the light fallback style.
 */
import type { Scope } from '@earth/domain'

import type { LatLng, MapBounds, MapViewport } from '../types'

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

/**
 * Light fallback style (no tiles): the map still shows Earth's objects on the white/light
 * design of SCREEN 20 when no style URL is configured. Colors are the spec palette (§89).
 */
export function fallbackStyle(colors: {
  readonly background: string
  readonly subtleFill: string
}): Record<string, unknown> {
  return {
    version: 8,
    name: 'earth-light',
    sources: {},
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': colors.subtleFill } },
    ],
    metadata: { 'earth:fallback': true, 'earth:surface': colors.background },
  }
}

/** Milliseconds the camera must rest before objects are fetched for the new box. */
export const MOVE_DEBOUNCE_MS = 300
