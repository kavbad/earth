/**
 * The MapLibre implementation of `EarthMap` — the only module that imports `maplibre-gl`.
 * Loaded on the client (`import()` inside the factory) so the map never touches the server
 * render. Motion follows spec §95 (180–300 ms); MapLibre honours `prefers-reduced-motion`.
 */
import { colors, motion } from '@earth/ui'
import type { MapOptions, Map as MapLibreMap, Marker } from 'maplibre-gl'

import 'maplibre-gl/dist/maplibre-gl.css'

import { clampBounds, fallbackStyle } from './state/view'
import type {
  EarthMap,
  EarthMapFactory,
  MapBounds,
  MapMoveState,
  MarkerElementItem,
  MarkerKind,
  MarkerTap,
} from './types'

export const MAP_MAX_ZOOM = 17
export const FIT_MAX_ZOOM = 15
export const FIT_PADDING_PX = 48

/** Data attributes the marker elements carry so taps can be attributed without vendor types. */
export const MARKER_KIND_ATTRIBUTE = 'data-marker-kind'
export const MARKER_ID_ATTRIBUTE = 'data-marker-id'

function boundsOf(map: MapLibreMap): MapBounds {
  const b = map.getBounds()
  return clampBounds([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()])
}

function moveState(map: MapLibreMap): MapMoveState {
  const center = map.getCenter()
  return {
    center: { lat: center.lat, lng: center.lng },
    zoom: map.getZoom(),
    bounds: boundsOf(map),
  }
}

export const createMapLibreEarthMap: EarthMapFactory = async (container, options) => {
  const lib = await import('maplibre-gl')
  const style = (options.styleUrl ??
    fallbackStyle({ background: colors.background, subtleFill: colors.subtleFill })) as NonNullable<
    MapOptions['style']
  >

  const map = new lib.Map({
    container,
    style,
    center: [options.initialView.center.lng, options.initialView.center.lat],
    zoom: options.initialView.zoom,
    maxZoom: MAP_MAX_ZOOM,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    fadeDuration: motion.duration.fast,
  })
  map.touchZoomRotate.disableRotation()
  map.addControl(new lib.AttributionControl({ compact: true }), 'bottom-left')
  container.setAttribute('role', 'region')
  container.setAttribute('aria-label', options.label)

  const markers = new Map<MarkerKind, Map<string, Marker>>()
  const tapListeners = new Set<(tap: MarkerTap) => void>()
  const clickHandlers = new WeakMap<HTMLElement, (event: Event) => void>()

  const attachTap = (kind: MarkerKind, id: string, element: HTMLElement): void => {
    element.setAttribute(MARKER_KIND_ATTRIBUTE, kind)
    element.setAttribute(MARKER_ID_ATTRIBUTE, id)
    const handler = (event: Event): void => {
      event.stopPropagation()
      const rect = element.getBoundingClientRect()
      const tap: MarkerTap = {
        kind,
        id,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      }
      for (const listener of tapListeners) listener(tap)
    }
    element.addEventListener('click', handler)
    clickHandlers.set(element, handler)
  }

  const detachTap = (element: HTMLElement): void => {
    const handler = clickHandlers.get(element)
    if (handler !== undefined) element.removeEventListener('click', handler)
    clickHandlers.delete(element)
  }

  const resizeObserver =
    typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => map.resize())
  resizeObserver?.observe(container)

  const earthMap: EarthMap = {
    setView(view, opts = {}) {
      const target = {
        center: [view.center.lng, view.center.lat] as [number, number],
        zoom: view.zoom,
      }
      if (opts.animate === false) map.jumpTo(target)
      else map.easeTo({ ...target, duration: motion.duration.slow, essential: true })
    },
    fitBounds(bounds, opts = {}) {
      map.fitBounds(
        [
          [bounds[0], bounds[1]],
          [bounds[2], bounds[3]],
        ],
        {
          padding: opts.padding ?? FIT_PADDING_PX,
          maxZoom: FIT_MAX_ZOOM,
          duration: opts.animate === false ? 0 : motion.duration.slow,
          essential: true,
        },
      )
    },
    addMarkers(kind, items: readonly MarkerElementItem[]) {
      const current = markers.get(kind) ?? new Map<string, Marker>()
      const next = new Map<string, Marker>()
      for (const item of items) {
        const existing = current.get(item.id)
        if (existing !== undefined && existing.getElement() === item.element) {
          existing.setLngLat([item.position.lng, item.position.lat])
          next.set(item.id, existing)
          current.delete(item.id)
          continue
        }
        const marker = new lib.Marker({ element: item.element, anchor: 'center' })
          .setLngLat([item.position.lng, item.position.lat])
          .addTo(map)
        attachTap(kind, item.id, item.element)
        next.set(item.id, marker)
      }
      for (const stale of current.values()) {
        detachTap(stale.getElement())
        stale.remove()
      }
      markers.set(kind, next)
    },
    onMove(listener) {
      const handler = (): void => listener(moveState(map))
      map.on('moveend', handler)
      return () => {
        map.off('moveend', handler)
      }
    },
    onMarkerTap(listener) {
      tapListeners.add(listener)
      return () => {
        tapListeners.delete(listener)
      }
    },
    getBounds: () => boundsOf(map),
    getZoom: () => map.getZoom(),
    project(position) {
      const point = map.project([position.lng, position.lat])
      return { x: point.x, y: point.y }
    },
    resize: () => map.resize(),
    destroy() {
      resizeObserver?.disconnect()
      for (const set of markers.values()) {
        for (const marker of set.values()) {
          detachTap(marker.getElement())
          marker.remove()
        }
      }
      markers.clear()
      tapListeners.clear()
      map.remove()
    },
  }

  await new Promise<void>((resolve) => {
    if (map.loaded()) resolve()
    else map.once('load', () => resolve())
    // A style that fails to load still yields a usable (blank) map; do not hang on it.
    map.once('error', () => resolve())
  })

  return earthMap
}
