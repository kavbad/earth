/**
 * Marker views of SCREEN 20 (spec §92): a Live is faces plus the small Live mark on white —
 * never a coloured border; a cluster is a count; a shared friend is a face inside a soft halo
 * whose size says how precise the share is; a Place is a small pin with its name; a Moment is a
 * quiet dot. Every view carries an accessible name; the map handles the tap.
 */
import { borderWidth, colors, radius, space, touchTarget } from '@earth/ui'
import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { Avatar } from '@/components/ui/Avatar'
import { FaceStack } from '@/components/ui/FaceStack'
import { Icon } from '@/components/ui/Icon'
import { LiveMark } from '@/components/ui/LiveMark'
import { text } from '@/components/ui/text'
import { mapCopy } from '@/features/earth/copy'
import type { LiveCluster } from '@/features/earth/state/cluster'
import {
  type FriendMarker,
  type LiveMarker,
  type MomentMarker,
  type PlaceMarker,
  friendHaloPt,
} from '@/features/earth/state/markers'

/** Accessible name shared by markers and the list view for a Live. */
export function liveLine(marker: LiveMarker): string {
  return `${marker.title} · ${mapCopy.participants(marker.participantCount)}`
}

const HALO_OPACITY = 0.12
/** A Moment is a quiet dot — the same size on the map and in the list. */
export const MOMENT_DOT = 12

function LiveMarkerViewBase({ marker }: { readonly marker: LiveMarker }) {
  const label = liveLine(marker)
  return (
    <View
      style={styles.pill}
      accessible
      accessibilityRole="button"
      accessibilityLabel={mapCopy.openRoom(label)}
    >
      {marker.faces.length > 0 ? (
        <FaceStack
          people={marker.faces}
          total={marker.participantCount}
          size="small"
          max={2}
          label={label}
        />
      ) : (
        <LiveMark text={false} />
      )}
      <Text style={[text.meta, text.primary, styles.pillText]} numberOfLines={1}>
        {marker.title}
      </Text>
      {marker.faces.length > 0 ? <LiveMark text={false} /> : null}
    </View>
  )
}
export const LiveMarkerView = memo(LiveMarkerViewBase)

function ClusterMarkerViewBase({ cluster }: { readonly cluster: LiveCluster }) {
  return (
    <View
      style={styles.cluster}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${mapCopy.liveHere(cluster.count)} · ${mapCopy.zoomIn}`}
    >
      <LiveMark text={false} />
      <Text style={[text.secondary, text.primary, styles.clusterCount]}>{cluster.count}</Text>
    </View>
  )
}
export const ClusterMarkerView = memo(ClusterMarkerViewBase)

function PlaceMarkerViewBase({
  marker,
  active = false,
}: {
  readonly marker: PlaceMarker
  readonly active?: boolean
}) {
  return (
    <View
      style={[styles.pill, active && styles.pillActive]}
      accessible
      accessibilityRole="button"
      accessibilityLabel={mapCopy.openPlace(marker.name)}
      accessibilityState={{ selected: active }}
    >
      <Icon name="location" size="small" color={active ? colors.background : colors.textPrimary} />
      <Text
        style={[text.meta, active ? text.inverse : text.primary, styles.placeText]}
        numberOfLines={1}
      >
        {marker.name}
      </Text>
    </View>
  )
}
export const PlaceMarkerView = memo(PlaceMarkerViewBase)

function FriendMarkerViewBase({ marker }: { readonly marker: FriendMarker }) {
  const halo = friendHaloPt(marker.precision)
  const box = Math.max(touchTarget, halo)
  return (
    <View
      style={[styles.friend, { width: box, height: box }]}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${marker.displayName} · ${mapCopy.precision[marker.precision]}`}
    >
      {halo > 0 ? (
        <View style={[styles.halo, { width: halo, height: halo, borderRadius: halo / 2 }]} />
      ) : null}
      <View style={[styles.face, marker.precision === 'precise' && styles.facePrecise]}>
        <Avatar name={marker.displayName} src={marker.avatarUrl} size="small" decorative />
      </View>
    </View>
  )
}
export const FriendMarkerView = memo(FriendMarkerViewBase)

function MomentMarkerViewBase({ marker }: { readonly marker: MomentMarker }) {
  return (
    <View
      style={styles.moment}
      accessible
      accessibilityRole="button"
      accessibilityLabel={mapCopy.momentBy(marker.authorDisplayName)}
    >
      <View style={styles.momentDot} />
    </View>
  )
}
export const MomentMarkerView = memo(MomentMarkerViewBase)

const styles = StyleSheet.create({
  pill: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[2],
    borderRadius: radius.avatar,
    backgroundColor: colors.background,
    borderWidth: borderWidth.separator,
    borderColor: colors.separator,
  },
  pillActive: { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
  pillText: { maxWidth: 140 },
  placeText: { maxWidth: 120 },
  cluster: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radius.avatar,
    backgroundColor: colors.background,
    borderWidth: borderWidth.separator,
    borderColor: colors.separator,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space[1],
  },
  clusterCount: { fontWeight: '500' },
  friend: { alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', backgroundColor: colors.earthAccent, opacity: HALO_OPACITY },
  face: {
    borderRadius: radius.avatar,
    borderWidth: borderWidth.indicator,
    borderColor: colors.background,
  },
  facePrecise: { borderColor: colors.earthAccent },
  moment: {
    width: touchTarget,
    height: touchTarget,
    alignItems: 'center',
    justifyContent: 'center',
  },
  momentDot: {
    width: MOMENT_DOT,
    height: MOMENT_DOT,
    borderRadius: MOMENT_DOT / 2,
    backgroundColor: colors.textPrimary,
    borderWidth: borderWidth.indicator,
    borderColor: colors.background,
  },
})
