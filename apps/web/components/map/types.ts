/**
 * The map abstraction of SCREEN 20 (spec §11, §20). Screens and markers talk to `EarthMap`;
 * only `./maplibre.ts` knows the vendor. Nothing here imports `maplibre-gl`, so no vendor type
 * leaves this folder.
 */
import type { BoundingBox, LatLngDto } from '@earth/domain'

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

/** The four object kinds SCREEN 20 draws; a cluster is a group of Lives. */
export const MARKER_KINDS = ['live', 'place', 'friend', 'moment'] as const
export type MarkerKind = (typeof MARKER_KINDS)[number]

/** A marker as the map receives it: a stable id, a position and the element React renders into. */
export interface MarkerElementItem {
  readonly id: string
  readonly position: LatLng
  readonly element: HTMLElement
}

export interface MarkerTap {
  readonly kind: MarkerKind
  readonly id: string
  /** Screen-space rectangle of the marker element (the expansion motion starts from it). */
  readonly rect: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
}

export interface ScreenPoint {
  readonly x: number
  readonly y: number
}

export interface EarthMap {
  /** Moves the camera; animated (spec §95: 180–300 ms) unless `animate` is false. */
  setView(view: MapViewport, options?: { readonly animate?: boolean }): void
  fitBounds(
    bounds: MapBounds,
    options?: { readonly padding?: number; readonly animate?: boolean },
  ): void
  /** Replaces every marker of `kind` with `items` (diffed by id). */
  addMarkers(kind: MarkerKind, items: readonly MarkerElementItem[]): void
  /** Fires after the camera settles (move end); returns the unsubscribe. */
  onMove(listener: (state: MapMoveState) => void): () => void
  /** Fires when a marker element receives a click (pointer or keyboard); returns the unsubscribe. */
  onMarkerTap(listener: (tap: MarkerTap) => void): () => void
  getBounds(): MapBounds
  getZoom(): number
  project(position: LatLng): ScreenPoint
  resize(): void
  destroy(): void
}

export interface EarthMapOptions {
  /** Style URL (`NEXT_PUBLIC_MAP_STYLE_URL`); a light inline style is used when absent. */
  readonly styleUrl: string | null
  readonly initialView: MapViewport
  /** Accessible name of the map region. */
  readonly label: string
}

export type EarthMapFactory = (
  container: HTMLElement,
  options: EarthMapOptions,
) => Promise<EarthMap>
