'use client'

import { VideoTrack } from '@livekit/components-react'
import type { TrackReference } from '@livekit/components-core'
import { copy } from '@earth/ui'

import { Avatar } from '../ui/Avatar'
import { Icon } from '../ui/Icon'
import { cx } from '../ui/cx'
import { roomCopy } from './copy'

export interface StageParticipant {
  readonly id: string
  readonly identity: string
  readonly displayName: string
  readonly avatarUrl: string | null
  readonly isGuest: boolean
  readonly isSelf: boolean
  readonly isSpeaking: boolean
  readonly micOn: boolean
  /** The camera track to render; `null` shows the face as an avatar (audio, muted, no SDK yet). */
  readonly videoTrack: TrackReference | null
  /** `videoTrack !== null` — the stage layout prefers faces with video (`state/stage.ts`). */
  readonly hasVideo: boolean
  /** Mirror the local front camera so the person sees themselves as in a mirror. */
  readonly mirrored: boolean
}

export interface ParticipantTileProps {
  readonly participant: StageParticipant
  readonly featured?: boolean
  readonly className?: string | undefined
}

/** One face: video when there is a camera track, otherwise the avatar; name and Guest tag below. */
export function ParticipantTile({
  participant,
  featured = false,
  className,
}: ParticipantTileProps) {
  const label = participant.isSelf ? roomCopy.you : participant.displayName
  return (
    <div
      role="group"
      aria-label={participant.isGuest ? `${label} (${copy.guest})` : label}
      className={cx(
        'relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-medium bg-subtle-fill transition-[box-shadow] duration-fast ease-standard',
        participant.isSpeaking && 'ring-2 ring-(color:--earth-color-text-secondary)',
        className,
      )}
    >
      {participant.videoTrack !== null ? (
        <VideoTrack
          trackRef={participant.videoTrack}
          className={cx('size-full object-cover', participant.mirrored && '-scale-x-100')}
          aria-hidden="true"
        />
      ) : (
        <Avatar
          name={participant.displayName}
          src={participant.avatarUrl}
          size={featured ? 'profile' : 'large'}
          decorative
        />
      )}
      <div className="absolute bottom-2 left-2 flex max-w-[calc(100%-var(--earth-space-4))] items-center gap-1 rounded-small bg-background/85 px-2 py-1 text-meta text-text-primary">
        <span className="truncate">{label}</span>
        {participant.isGuest ? (
          <span className="shrink-0 text-text-secondary">{copy.guest}</span>
        ) : null}
        {!participant.micOn ? (
          <Icon
            name="micOff"
            size="small"
            title={copy.roomControls.microphone}
            className="shrink-0 text-text-secondary"
          />
        ) : null}
      </div>
    </div>
  )
}
