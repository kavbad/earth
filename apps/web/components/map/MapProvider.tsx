'use client'

/**
 * The thin map abstraction of SCREEN 20 as React: `MapProvider` mounts an `EarthMap`
 * (MapLibre by default, injectable for tests) into a full-bleed container, `useEarthMap()`
 * hands it to overlays, and `MarkerLayer` renders React marker components into the map through
 * portals so markers stay ordinary accessible buttons. No vendor type crosses this file.
 */
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { cx } from '../ui/cx'
import { mapCopy } from './copy'
import type {
  EarthMap,
  EarthMapFactory,
  LatLng,
  MapViewport,
  MarkerElementItem,
  MarkerKind,
} from './types'

export type {
  EarthMap,
  EarthMapFactory,
  EarthMapOptions,
  LatLng,
  MapBounds,
  MapMoveState,
  MapViewport,
  MarkerElementItem,
  MarkerKind,
  MarkerTap,
  ScreenPoint,
} from './types'

export type MapStatus = 'loading' | 'ready' | 'failed'

export interface MapContextValue {
  readonly map: EarthMap | null
  readonly status: MapStatus
}

const MapContext = createContext<MapContextValue>({ map: null, status: 'loading' })

/** Loaded lazily so `maplibre-gl` (browser-only) never enters a server render. */
const defaultFactory: EarthMapFactory = async (container, options) => {
  const mod = await import('./maplibre')
  return mod.createMapLibreEarthMap(container, options)
}

export interface MapProviderProps {
  readonly styleUrl: string | null
  readonly initialView: MapViewport
  readonly factory?: EarthMapFactory | undefined
  readonly label?: string
  /** Overlays (controls, markers) rendered above the map, inside the same relative box. */
  readonly children?: ReactNode
  readonly className?: string | undefined
}

export function MapProvider({
  styleUrl,
  initialView,
  factory,
  label = mapCopy.mapLabel,
  children,
  className,
}: MapProviderProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<EarthMap | null>(null)
  const [status, setStatus] = useState<MapStatus>('loading')
  // The initial view is read once: later camera moves go through `useEarthMap()`.
  const initial = useRef(initialView)

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return
    let cancelled = false
    let created: EarthMap | null = null
    const create = factory ?? defaultFactory
    create(container, { styleUrl, initialView: initial.current, label })
      .then((instance) => {
        if (cancelled) {
          instance.destroy()
          return
        }
        created = instance
        setMap(instance)
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setStatus('failed')
      })
    return () => {
      cancelled = true
      created?.destroy()
      setMap(null)
      setStatus('loading')
    }
  }, [factory, styleUrl, label])

  const value = useMemo<MapContextValue>(() => ({ map, status }), [map, status])

  return (
    <MapContext.Provider value={value}>
      <div className={cx('relative h-full w-full bg-subtle-fill', className)}>
        <div ref={containerRef} className="absolute inset-0" />
        {children}
      </div>
    </MapContext.Provider>
  )
}

export function useEarthMap(): MapContextValue {
  return useContext(MapContext)
}

export interface MarkerItem {
  readonly id: string
  readonly position: LatLng
}

export interface MarkerLayerProps<T extends MarkerItem> {
  readonly kind: MarkerKind
  readonly items: readonly T[]
  readonly render: (item: T) => ReactNode
}

/**
 * Keeps one DOM element per item id, hands them to `EarthMap.addMarkers` and renders the React
 * marker into each through a portal. Removed items drop their element.
 */
export function MarkerLayer<T extends MarkerItem>({ kind, items, render }: MarkerLayerProps<T>) {
  const { map } = useEarthMap()
  // One element per item id for the life of the layer. The cache is state (never replaced), so
  // an item that stays keeps its element — and therefore its map marker — across data refreshes.
  const [elements] = useState(() => new Map<string, HTMLElement>())
  const canRender = typeof document !== 'undefined'

  const entries = useMemo(() => {
    if (!canRender) return []
    const seen = new Set<string>()
    const out: Array<{ readonly item: T; readonly element: HTMLElement }> = []
    for (const item of items) {
      seen.add(item.id)
      let element = elements.get(item.id)
      if (element === undefined) {
        element = document.createElement('div')
        element.className = 'earth-marker'
        elements.set(item.id, element)
      }
      out.push({ item, element })
    }
    for (const id of Array.from(elements.keys())) {
      if (!seen.has(id)) elements.delete(id)
    }
    return out
  }, [items, canRender, elements])

  useLayoutEffect(() => {
    if (map === null) return
    const markerItems: MarkerElementItem[] = entries.map(({ item, element }) => ({
      id: item.id,
      position: item.position,
      element,
    }))
    map.addMarkers(kind, markerItems)
  }, [map, kind, entries])

  useEffect(() => {
    if (map === null) return
    return () => {
      map.addMarkers(kind, [])
    }
  }, [map, kind])

  return (
    <>
      {entries.map(({ item, element }) => (
        <MarkerPortal key={item.id} element={element}>
          {render(item)}
        </MarkerPortal>
      ))}
    </>
  )
}

function MarkerPortal({
  element,
  children,
}: {
  readonly element: HTMLElement
  readonly children: ReactNode
}) {
  return createPortal(children, element)
}
