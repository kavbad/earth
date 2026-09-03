/**
 * The map as React: `MapProvider` mounts the native `EarthMap` full-bleed with the marker layers
 * it is given, `useEarthMap()` hands the camera to overlays (controls, sheets) rendered above
 * it inside the same box. No vendor type crosses this file.
 */
import { colors } from '@earth/ui'
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react'
import { StyleSheet, View } from 'react-native'

import { mapCopy } from '@/features/earth/copy'

import { NativeEarthMap } from './NativeEarthMap'
import type { EarthMap, MapMoveState, MapStatus, MapViewport, MarkerLayer } from './types'

export interface MapContextValue {
  readonly map: EarthMap | null
  readonly status: MapStatus
}

const MapContext = createContext<MapContextValue>({ map: null, status: 'loading' })

export interface MapProviderProps {
  readonly initialView: MapViewport
  readonly layers: readonly MarkerLayer[]
  readonly onMove?: ((state: MapMoveState) => void) | undefined
  /** The camera, once the native map is ready (for callers outside the overlay tree). */
  readonly onReady?: ((map: EarthMap) => void) | undefined
  readonly onStatusChange?: ((status: MapStatus) => void) | undefined
  readonly label?: string
  /** Overlays (controls, notices, sheets) rendered above the map. */
  readonly children?: ReactNode
}

export function MapProvider({
  initialView,
  layers,
  onMove,
  onReady: onReadyProp,
  onStatusChange,
  label = mapCopy.mapLabel,
  children,
}: MapProviderProps) {
  // The initial view is read once: later camera moves go through `useEarthMap()`.
  const [initial] = useState(initialView)
  const handle = useRef<EarthMap | null>(null)
  const [map, setMap] = useState<EarthMap | null>(null)
  const [status, setStatus] = useState<MapStatus>('loading')

  const onReady = useCallback(() => {
    const created = handle.current
    setMap(created)
    const next: MapStatus = created === null ? 'failed' : 'ready'
    setStatus(next)
    onStatusChange?.(next)
    if (created !== null) onReadyProp?.(created)
  }, [onReadyProp, onStatusChange])

  const value = useMemo<MapContextValue>(() => ({ map, status }), [map, status])

  return (
    <MapContext.Provider value={value}>
      <View style={styles.root}>
        <NativeEarthMap
          ref={handle}
          initialView={initial}
          label={label}
          layers={layers}
          onMove={onMove}
          onReady={onReady}
        />
        {children}
      </View>
    </MapContext.Provider>
  )
}

export function useEarthMap(): MapContextValue {
  return useContext(MapContext)
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.subtleFill },
})
