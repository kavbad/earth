'use client'

/**
 * The map's objects as a list (SCREEN 20 companion): the accessible, small-screen way to reach
 * every Live, friend, Place and Moment the box holds. Rows are buttons; Lives open the room.
 */
import { copy } from '@earth/ui'

import { Avatar } from '../ui/Avatar'
import { EmptyState } from '../ui/EmptyState'
import { FaceStack } from '../ui/FaceStack'
import { Icon } from '../ui/Icon'
import { List, ListRow } from '../ui/ListRow'
import { LiveMark } from '../ui/LiveMark'
import { Sheet } from '../ui/Sheet'
import { liveLine } from './Markers'
import { mapCopy } from './copy'
import type {
  FriendMarker,
  LiveMarker,
  MarkerSets,
  MomentMarker,
  PlaceMarker,
} from './state/markers'
import { formatClock } from '../location/state/duration'

export interface MapObjectsListProps {
  readonly open: boolean
  readonly markers: MarkerSets
  readonly onClose: () => void
  readonly onOpenLive: (marker: LiveMarker) => void
  readonly onFocusFriend: (marker: FriendMarker) => void
  readonly onFocusPlace: (marker: PlaceMarker) => void
  readonly onOpenMoment: (marker: MomentMarker) => void
}

function Section({
  title,
  children,
}: {
  readonly title: string
  readonly children: React.ReactNode
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <h3 className="text-meta text-text-secondary">{title}</h3>
      {children}
    </section>
  )
}

export function MapObjectsList(props: MapObjectsListProps) {
  const { markers } = props
  const empty =
    markers.lives.length === 0 &&
    markers.friends.length === 0 &&
    markers.places.length === 0 &&
    markers.moments.length === 0
  return (
    <Sheet open={props.open} onClose={props.onClose} title={mapCopy.listView} closeButton>
      {empty ? (
        <EmptyState title={mapCopy.nothingHere} className="px-0 py-4" />
      ) : (
        <div className="flex flex-col gap-5">
          {markers.lives.length > 0 ? (
            <Section title={copy.tabs.live}>
              <List>
                {markers.lives.map((marker) => (
                  <ListRow
                    key={marker.id}
                    as="button"
                    onClick={() => props.onOpenLive(marker)}
                    leading={
                      marker.faces.length > 0 ? (
                        <FaceStack
                          people={marker.faces}
                          total={marker.participantCount}
                          label={liveLine(marker)}
                        />
                      ) : (
                        <LiveMark text={false} />
                      )
                    }
                    title={marker.title}
                    subtitle={mapCopy.participants(marker.participantCount)}
                    trailing={<LiveMark />}
                    className="px-0"
                  />
                ))}
              </List>
            </Section>
          ) : null}
          {markers.friends.length > 0 ? (
            <Section title={mapCopy.sections.friends}>
              <List>
                {markers.friends.map((marker) => (
                  <ListRow
                    key={marker.id}
                    as="button"
                    onClick={() => props.onFocusFriend(marker)}
                    leading={
                      <Avatar
                        name={marker.displayName}
                        src={marker.avatarUrl}
                        size="small"
                        decorative
                      />
                    }
                    title={marker.displayName}
                    subtitle={`${mapCopy.precision[marker.precision]} · ${mapCopy.sharingUntil(formatClock(new Date(marker.expiresAt)))}`}
                    className="px-0"
                  />
                ))}
              </List>
            </Section>
          ) : null}
          {markers.places.length > 0 ? (
            <Section title={mapCopy.sections.places}>
              <List>
                {markers.places.map((marker) => (
                  <ListRow
                    key={marker.id}
                    as="button"
                    onClick={() => props.onFocusPlace(marker)}
                    leading={<Icon name="location" />}
                    title={marker.name}
                    subtitle={[marker.category, marker.areaName]
                      .filter((part) => part !== null && part !== '')
                      .join(' · ')}
                    className="px-0"
                  />
                ))}
              </List>
            </Section>
          ) : null}
          {markers.moments.length > 0 ? (
            <Section title={mapCopy.sections.moments}>
              <List>
                {markers.moments.map((marker) => (
                  <ListRow
                    key={marker.id}
                    as="button"
                    onClick={() => props.onOpenMoment(marker)}
                    title={mapCopy.momentBy(marker.authorDisplayName)}
                    className="px-0"
                  />
                ))}
              </List>
            </Section>
          ) : null}
        </div>
      )}
    </Sheet>
  )
}
