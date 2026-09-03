/**
 * Marker components of SCREEN 20. Every marker is a real button with an accessible name; a Live
 * is faces plus the small Live mark (spec §92 — never a coloured border); a cluster is a count;
 * a shared friend is a face inside a soft halo whose size says how precise the share is; a Place
 * is a small pin with its name; a Moment is a quiet dot. Colours and sizes are tokens only.
 */
import { copy } from '@earth/ui'

import { FaceStack } from '../ui/FaceStack'
import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { LiveMark } from '../ui/LiveMark'
import { cx } from '../ui/cx'
import { mapCopy } from './copy'
import type { LiveCluster } from './state/cluster'
import {
  type FriendMarker,
  type LiveMarker,
  type MomentMarker,
  type PlaceMarker,
  friendHaloPx,
} from './state/markers'

const PILL_CLASS =
  'flex min-h-touch-target items-center gap-2 rounded-avatar bg-background px-2 text-meta text-text-primary ring-1 ring-separator transition-transform duration-fast ease-standard hover:scale-105 active:scale-95'

export function LiveMarkerView({ marker }: { readonly marker: LiveMarker }) {
  const label = `${marker.title} · ${mapCopy.participants(marker.participantCount)}`
  return (
    <button type="button" aria-label={mapCopy.openRoom(label)} className={PILL_CLASS}>
      {marker.faces.length > 0 ? (
        <FaceStack
          people={marker.faces}
          total={marker.participantCount}
          size="small"
          label={label}
          max={2}
        />
      ) : (
        <LiveMark text={false} />
      )}
      <span className="max-w-[140px] truncate">{marker.title}</span>
      {marker.faces.length > 0 ? <LiveMark text={false} /> : null}
    </button>
  )
}

export function ClusterMarkerView({ cluster }: { readonly cluster: LiveCluster }) {
  return (
    <button
      type="button"
      aria-label={`${mapCopy.liveHere(cluster.count)} · ${mapCopy.zoomIn}`}
      className="flex size-touch-target items-center justify-center gap-1 rounded-avatar bg-background text-secondary font-medium text-text-primary ring-1 ring-separator transition-transform duration-fast ease-standard hover:scale-105 active:scale-95"
    >
      <LiveMark text={false} />
      <span aria-hidden="true">{cluster.count}</span>
    </button>
  )
}

export function PlaceMarkerView({
  marker,
  active = false,
}: {
  readonly marker: PlaceMarker
  readonly active?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={mapCopy.openPlace(marker.name)}
      aria-current={active ? 'location' : undefined}
      className={cx(
        'flex min-h-touch-target items-center gap-1 rounded-avatar px-2 text-meta transition-colors duration-fast ease-standard',
        active
          ? 'bg-text-primary text-background'
          : 'bg-background text-text-primary ring-1 ring-separator',
      )}
    >
      <Icon name="location" size="small" />
      <span className="max-w-[120px] truncate">{marker.name}</span>
    </button>
  )
}

export function FriendMarkerView({ marker }: { readonly marker: FriendMarker }) {
  const halo = friendHaloPx(marker.precision)
  return (
    <button
      type="button"
      aria-label={`${marker.displayName} · ${mapCopy.precision[marker.precision]}`}
      className="relative flex size-touch-target items-center justify-center rounded-avatar bg-transparent"
    >
      {halo > 0 ? (
        <span
          aria-hidden="true"
          className="absolute rounded-avatar bg-earth-accent/10"
          style={{ width: halo, height: halo }}
        />
      ) : null}
      <Avatar
        name={marker.displayName}
        src={marker.avatarUrl}
        size="small"
        decorative
        className={cx(
          'relative ring-2 ring-background',
          marker.precision === 'precise' && 'ring-earth-accent',
        )}
      />
    </button>
  )
}

export function MomentMarkerView({ marker }: { readonly marker: MomentMarker }) {
  return (
    <button
      type="button"
      aria-label={mapCopy.momentBy(marker.authorDisplayName)}
      className="flex size-touch-target items-center justify-center rounded-avatar bg-transparent"
    >
      <span
        aria-hidden="true"
        className="size-3 rounded-avatar bg-text-primary ring-2 ring-background"
      />
    </button>
  )
}

/** Accessible name shared by markers and the list view for a Live. */
export function liveLine(marker: LiveMarker): string {
  return `${marker.title} · ${mapCopy.participants(marker.participantCount)}`
}

/** `Live` word for section headers etc. */
export const LIVE_WORD = copy.tabs.live
