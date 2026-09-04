/**
 * The map abstraction of SCREEN 20 (spec §11, §20). Screens and markers talk to `EarthMap` and
 * describe markers as layers; only `./NativeEarthMap.tsx` knows `react-native-maps`. Nothing
 * here imports the vendor, so no vendor type leaves this folder.
 */
import type { ReactNode } from 'react'

import type { MarkerKind } from '@/features/earth/state/markers'
import type { LatLng, MapBounds, MapMoveState, MapViewport } from '@/features/earth/state/view'

export type { LatLng, MapBounds, MapMoveState, MapViewport, MarkerKind }

export interface ScreenPoint {
  readonly x: number
  readonly y: number
}

/** A marker as a layer describes it: a stable id and a position. */
export interface MarkerItem {
  readonly id: string
  readonly position: LatLng
}

export interface MarkerLayerSpec<T extends MarkerItem> {
  readonly kind: MarkerKind
  readonly items: readonly T[]
  /** The React view drawn at the position (an accessible, 44pt element). */
  readonly render: (item: T) => ReactNode
  /** A tap on the marker; `point` is where it sits on screen when the platform knows. */
  readonly onTap: (item: T, point: ScreenPoint | null) => void
  /** Which point of the view sits on the coordinate (0–1 in both axes); centre by default. */
  readonly anchor?: ScreenPoint
  readonly zIndex?: number
}

/** A layer erased to the base item type so heterogeneous layers fit in one list. */
export type MarkerLayer = MarkerLayerSpec<MarkerItem>

export function markerLayer<T extends MarkerItem>(spec: MarkerLayerSpec<T>): MarkerLayer {
  return spec as unknown as MarkerLayer
}

export interface EarthMap {
  /** Moves the camera; animated (spec §95: 180–300 ms) unless `animate` is false. */
  setView(view: MapViewport, options?: { readonly animate?: boolean }): void
  fitBounds(
    bounds: MapBounds,
    options?: { readonly padding?: number; readonly animate?: boolean },
  ): void
  /** Where a position sits on screen, or `null` when the map cannot say. */
  project(position: LatLng): Promise<ScreenPoint | null>
}

export type MapStatus = 'loading' | 'ready' | 'failed'

export interface EarthMapProps {
  readonly initialView: MapViewport
  /** Accessible name of the map region. */
  readonly label: string
  readonly layers: readonly MarkerLayer[]
  /** Fires after the camera settles (region change complete). */
  readonly onMove?: ((state: MapMoveState) => void) | undefined
  readonly onReady?: (() => void) | undefined
}
