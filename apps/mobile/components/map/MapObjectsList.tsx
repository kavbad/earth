/**
 * The map's objects as a list (SCREEN 20 companion): the accessible, small-screen way to reach
 * every Live, friend, Place and Moment the box holds. One FlatList of fixed-height rows (section
 * headers included) so it can jump; Lives open the room, the rest focus the map.
 */
import { colors, space, spacing, touchTarget } from '@earth/ui'
import { type ReactNode, memo, useCallback, useMemo } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'

import { Avatar } from '@/components/ui/Avatar'
import { EmptyState } from '@/components/ui/EmptyState'
import { FaceStack } from '@/components/ui/FaceStack'
import { Icon } from '@/components/ui/Icon'
import { LiveMark } from '@/components/ui/LiveMark'
import { Sheet } from '@/components/ui/Sheet'
import { text } from '@/components/ui/text'
import { locationCopy, mapCopy } from '@/features/earth/copy'
import { formatClock } from '@/features/earth/state/duration'
import type {
  FriendMarker,
  LiveMarker,
  MarkerSets,
  MomentMarker,
  PlaceMarker,
} from '@/features/earth/state/markers'

import { MOMENT_DOT, liveLine } from './Markers'

export const LIST_ROW_HEIGHT = 56

export interface MapObjectsListProps {
  readonly open: boolean
  readonly markers: MarkerSets
  readonly onClose: () => void
  readonly onOpenLive: (marker: LiveMarker) => void
  readonly onFocusFriend: (marker: FriendMarker) => void
  readonly onFocusPlace: (marker: PlaceMarker) => void
  readonly onOpenMoment: (marker: MomentMarker) => void
}

type Row =
  | { readonly kind: 'header'; readonly id: string; readonly title: string }
  | { readonly kind: 'live'; readonly id: string; readonly marker: LiveMarker }
  | { readonly kind: 'friend'; readonly id: string; readonly marker: FriendMarker }
  | { readonly kind: 'place'; readonly id: string; readonly marker: PlaceMarker }
  | { readonly kind: 'moment'; readonly id: string; readonly marker: MomentMarker }

export function rowsFor(markers: MarkerSets): Row[] {
  const rows: Row[] = []
  if (markers.lives.length > 0) {
    rows.push({ kind: 'header', id: 'h:lives', title: mapCopy.sections.lives })
    for (const marker of markers.lives) rows.push({ kind: 'live', id: marker.id, marker })
  }
  if (markers.friends.length > 0) {
    rows.push({ kind: 'header', id: 'h:friends', title: mapCopy.sections.friends })
    for (const marker of markers.friends) rows.push({ kind: 'friend', id: marker.id, marker })
  }
  if (markers.places.length > 0) {
    rows.push({ kind: 'header', id: 'h:places', title: mapCopy.sections.places })
    for (const marker of markers.places) rows.push({ kind: 'place', id: marker.id, marker })
  }
  if (markers.moments.length > 0) {
    rows.push({ kind: 'header', id: 'h:moments', title: mapCopy.sections.moments })
    for (const marker of markers.moments) rows.push({ kind: 'moment', id: marker.id, marker })
  }
  return rows
}

function keyExtractor(row: Row): string {
  return row.id
}

function getItemLayout(_data: ArrayLike<Row> | null | undefined, index: number) {
  return { length: LIST_ROW_HEIGHT, offset: LIST_ROW_HEIGHT * index, index }
}

interface RowViewProps {
  readonly row: Row
  readonly onPress: (row: Row) => void
}

function RowViewBase({ row, onPress }: RowViewProps) {
  if (row.kind === 'header') {
    return (
      <View style={styles.header} accessibilityRole="header">
        <Text style={[text.meta, text.muted]}>{row.title}</Text>
      </View>
    )
  }
  let label: string
  let leading: ReactNode
  let title: string
  let subtitle: string | null = null
  let trailing: ReactNode = null
  switch (row.kind) {
    case 'live':
      label = mapCopy.openRoom(liveLine(row.marker))
      title = row.marker.title
      subtitle = mapCopy.participants(row.marker.participantCount)
      leading =
        row.marker.faces.length > 0 ? (
          <FaceStack
            people={row.marker.faces}
            total={row.marker.participantCount}
            size="small"
            label={row.marker.title}
          />
        ) : (
          <LiveMark text={false} />
        )
      trailing = <LiveMark text={false} />
      break
    case 'friend':
      label = locationCopy.showOnMap(row.marker.displayName)
      title = row.marker.displayName
      subtitle = `${mapCopy.precision[row.marker.precision]} · ${mapCopy.sharingUntil(formatClock(new Date(row.marker.expiresAt)))}`
      leading = (
        <Avatar name={row.marker.displayName} src={row.marker.avatarUrl} size="small" decorative />
      )
      break
    case 'place':
      label = mapCopy.openPlace(row.marker.name)
      title = row.marker.name
      subtitle = row.marker.areaName
      leading = <Icon name="location" />
      break
    case 'moment':
      label = mapCopy.momentBy(row.marker.authorDisplayName)
      title = mapCopy.momentBy(row.marker.authorDisplayName)
      leading = <View style={styles.momentDot} />
      break
    default: {
      const exhaustive: never = row
      throw new Error(`Unknown row: ${String(exhaustive)}`)
    }
  }
  return (
    <Pressable
      onPress={() => onPress(row)}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.leading}>{leading}</View>
      <View style={styles.middle}>
        <Text style={[text.body, text.primary]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle !== null && subtitle.length > 0 ? (
          <Text style={[text.secondary, text.muted]} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
    </Pressable>
  )
}
const RowView = memo(RowViewBase)

export function MapObjectsList(props: MapObjectsListProps) {
  const { markers, onOpenLive, onFocusFriend, onFocusPlace, onOpenMoment } = props
  const rows = useMemo(() => rowsFor(markers), [markers])
  const onPress = useCallback(
    (row: Row) => {
      switch (row.kind) {
        case 'live':
          onOpenLive(row.marker)
          return
        case 'friend':
          onFocusFriend(row.marker)
          return
        case 'place':
          onFocusPlace(row.marker)
          return
        case 'moment':
          onOpenMoment(row.marker)
          return
        case 'header':
          return
        default: {
          const exhaustive: never = row
          throw new Error(`Unknown row: ${String(exhaustive)}`)
        }
      }
    },
    [onOpenLive, onFocusFriend, onFocusPlace, onOpenMoment],
  )
  const renderItem = useCallback(
    ({ item }: { item: Row }) => <RowView row={item} onPress={onPress} />,
    [onPress],
  )
  return (
    <Sheet open={props.open} onClose={props.onClose} title={mapCopy.listView} closeButton>
      {rows.length === 0 ? (
        <EmptyState title={mapCopy.nothingHere} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          windowSize={7}
          initialNumToRender={12}
          maxToRenderPerBatch={12}
          removeClippedSubviews
          style={styles.list}
          accessibilityLabel={mapCopy.listView}
        />
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  list: { maxHeight: 480 },
  header: {
    height: LIST_ROW_HEIGHT,
    justifyContent: 'flex-end',
    paddingBottom: space[2],
  },
  row: {
    height: LIST_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.rowGapLoose,
    backgroundColor: colors.background,
  },
  pressed: { backgroundColor: colors.subtleFill },
  leading: { width: touchTarget, alignItems: 'center', justifyContent: 'center' },
  middle: { flex: 1, minWidth: 0 },
  momentDot: {
    width: MOMENT_DOT,
    height: MOMENT_DOT,
    borderRadius: MOMENT_DOT / 2,
    backgroundColor: colors.textPrimary,
  },
})
