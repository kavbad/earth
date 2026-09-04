/**
 * Grid clustering for Live markers (SCREEN 20 Neighborhood/City/World: "public Live clusters").
 * Deterministic and dependency-free: the world is cut into cells whose size follows the zoom;
 * Lives in the same cell collapse into one cluster with a count and the box of its members.
 */
import type { LiveMarker } from './markers'
import { type LatLng, type MapBounds, boundsAround } from './view'

export interface LiveCluster {
  readonly kind: 'cluster'
  readonly id: string
  readonly position: LatLng
  readonly count: number
  readonly members: readonly LiveMarker[]
  readonly bounds: MapBounds
  /** Sum of participants across the members. */
  readonly participantCount: number
}

export type LiveMapItem = LiveMarker | LiveCluster

/** Cell size in degrees at zoom 0; halves with every zoom level. */
export const CLUSTER_CELL_DEGREES_AT_ZOOM_0 = 40
/** Above this zoom nothing is clustered — every Live stands on its own. */
export const CLUSTER_MAX_ZOOM = 14

export function cellSizeForZoom(zoom: number): number {
  const clamped = Math.max(0, Math.min(CLUSTER_MAX_ZOOM, zoom))
  return CLUSTER_CELL_DEGREES_AT_ZOOM_0 / 2 ** clamped
}

function cellKey(position: LatLng, size: number): string {
  const col = Math.floor((position.lng + 180) / size)
  const row = Math.floor((position.lat + 90) / size)
  return `${col}:${row}`
}

function centroid(markers: readonly LiveMarker[]): LatLng {
  let lat = 0
  let lng = 0
  for (const marker of markers) {
    lat += marker.position.lat
    lng += marker.position.lng
  }
  return { lat: lat / markers.length, lng: lng / markers.length }
}

/** Lives in cell order; singletons stay markers, cells with ≥ 2 Lives become clusters. */
export function clusterLives(lives: readonly LiveMarker[], zoom: number): LiveMapItem[] {
  if (zoom >= CLUSTER_MAX_ZOOM) return [...lives]
  const size = cellSizeForZoom(zoom)
  const cells = new Map<string, LiveMarker[]>()
  for (const live of lives) {
    const key = cellKey(live.position, size)
    const cell = cells.get(key)
    if (cell === undefined) cells.set(key, [live])
    else cell.push(live)
  }
  const out: LiveMapItem[] = []
  for (const [key, members] of cells) {
    const first = members[0]
    if (first === undefined) continue
    if (members.length === 1) {
      out.push(first)
      continue
    }
    const bounds = boundsAround(members.map((m) => m.position))
    if (bounds === null) continue
    out.push({
      kind: 'cluster',
      id: `cluster:${key}`,
      position: centroid(members),
      count: members.length,
      members,
      bounds,
      participantCount: members.reduce((sum, m) => sum + m.participantCount, 0),
    })
  }
  return out
}

export function isCluster(item: LiveMapItem): item is LiveCluster {
  return item.kind === 'cluster'
}
