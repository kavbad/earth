/**
 * The `react-native-maps` implementation of `EarthMap` — the only module that imports the
 * vendor. Light Earth design (spec §89): the custom JSON style for Google on Android, Apple's
 * muted standard style on iOS, no points of interest, no tilt or rotation. Markers are the
 * layers' React views, anchored on their coordinate; a tap reports the item and its screen point.
 */
import { colors, motion } from '@earth/ui'
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import { type LayoutChangeEvent, Platform, StyleSheet, View } from 'react-native'
import MapView, { type MapStyleElement, Marker, type Region } from 'react-native-maps'

import {
  DEFAULT_ASPECT,
  MAP_MAX_ZOOM,
  lightMapStyle,
  moveStateForRegion,
  regionForView,
} from '@/features/earth/state/view'

import type { EarthMap, EarthMapProps, MarkerItem, MarkerLayer, ScreenPoint } from './types'

/** Ticks a marker keeps re-rendering after it changed so a loaded face reaches the bitmap. */
const TRACK_VIEW_CHANGES_MS = 1_500
const FIT_PADDING_PT = 48
const CENTER: ScreenPoint = { x: 0.5, y: 0.5 }

const LIGHT_STYLE: MapStyleElement[] = lightMapStyle({
  background: colors.background,
  subtleFill: colors.subtleFill,
  separator: colors.separator,
  textSecondary: colors.textSecondary,
}).map((rule) => ({
  ...(rule.featureType === undefined ? {} : { featureType: rule.featureType }),
  ...(rule.elementType === undefined ? {} : { elementType: rule.elementType }),
  stylers: rule.stylers.map((styler) => ({ ...styler })),
}))

interface NativeMarkerProps {
  readonly layer: MarkerLayer
  readonly item: MarkerItem
  readonly onTap: (layer: MarkerLayer, item: MarkerItem, point: ScreenPoint | null) => void
}

function NativeMarkerView({ layer, item, onTap }: NativeMarkerProps) {
  // Android draws custom markers once; keep tracking briefly so images that load land on it.
  const [tracks, setTracks] = useState(true)
  useEffect(() => {
    const timer = setTimeout(() => setTracks(false), TRACK_VIEW_CHANGES_MS)
    return () => clearTimeout(timer)
  }, [])
  const anchor = layer.anchor ?? CENTER
  return (
    <Marker
      coordinate={{ latitude: item.position.lat, longitude: item.position.lng }}
      anchor={anchor}
      centerOffset={{ x: 0, y: 0 }}
      tracksViewChanges={tracks}
      stopPropagation
      {...(layer.zIndex === undefined ? {} : { zIndex: layer.zIndex })}
      onPress={(event) => {
        const position = event.nativeEvent.position
        onTap(layer, item, position === undefined ? null : { x: position.x, y: position.y })
      }}
    >
      <View collapsable={false}>{layer.render(item)}</View>
    </Marker>
  )
}

const NativeMarker = memo(NativeMarkerView)

export const NativeEarthMap = forwardRef<EarthMap, EarthMapProps>(function NativeEarthMap(
  { initialView, label, layers, onMove, onReady },
  ref,
) {
  const mapRef = useRef<MapView>(null)
  const aspect = useRef(DEFAULT_ASPECT)
  const initialRegion = useMemo(() => regionForView(initialView, DEFAULT_ASPECT), [initialView])

  useImperativeHandle(
    ref,
    (): EarthMap => ({
      setView(view, options = {}) {
        const region = regionForView(view, aspect.current)
        mapRef.current?.animateToRegion(
          region,
          options.animate === false ? 0 : motion.duration.slow,
        )
      },
      fitBounds(bounds, options = {}) {
        const padding = options.padding ?? FIT_PADDING_PT
        mapRef.current?.fitToCoordinates(
          [
            { latitude: bounds[1], longitude: bounds[0] },
            { latitude: bounds[3], longitude: bounds[2] },
          ],
          {
            edgePadding: { top: padding, right: padding, bottom: padding, left: padding },
            animated: options.animate !== false,
          },
        )
      },
      async project(position) {
        const map = mapRef.current
        if (map === null) return null
        try {
          const point = await map.pointForCoordinate({
            latitude: position.lat,
            longitude: position.lng,
          })
          return { x: point.x, y: point.y }
        } catch {
          return null
        }
      },
    }),
    [],
  )

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    if (width > 0 && height > 0) aspect.current = height / width
  }, [])

  const onRegionChangeComplete = useCallback(
    (region: Region) => {
      onMove?.(moveStateForRegion(region))
    },
    [onMove],
  )

  const onTap = useCallback(
    async (layer: MarkerLayer, item: MarkerItem, point: ScreenPoint | null) => {
      let where = point
      if (where === null && mapRef.current !== null) {
        try {
          const projected = await mapRef.current.pointForCoordinate({
            latitude: item.position.lat,
            longitude: item.position.lng,
          })
          where = { x: projected.x, y: projected.y }
        } catch {
          where = null
        }
      }
      layer.onTap(item, where)
    },
    [],
  )

  return (
    <View style={styles.root} onLayout={onLayout} accessibilityLabel={label} accessible={false}>
      <MapView
        ref={mapRef}
        style={styles.map}
        initialRegion={initialRegion}
        onRegionChangeComplete={onRegionChangeComplete}
        onMapReady={() => onReady?.()}
        customMapStyle={LIGHT_STYLE}
        mapType={Platform.OS === 'ios' ? 'mutedStandard' : 'standard'}
        userInterfaceStyle="light"
        showsPointsOfInterests={false}
        showsBuildings={false}
        showsTraffic={false}
        showsIndoors={false}
        showsCompass={false}
        showsScale={false}
        pitchEnabled={false}
        rotateEnabled={false}
        toolbarEnabled={false}
        moveOnMarkerPress={false}
        maxZoomLevel={MAP_MAX_ZOOM}
        loadingEnabled
        loadingBackgroundColor={colors.subtleFill}
        loadingIndicatorColor={colors.textSecondary}
      >
        {layers.map((layer) =>
          layer.items.map((item) => (
            <NativeMarker
              key={`${layer.kind}:${item.id}`}
              layer={layer}
              item={item}
              onTap={(l, i, p) => void onTap(l, i, p)}
            />
          )),
        )}
      </MapView>
    </View>
  )
})

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.subtleFill },
  map: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
})
