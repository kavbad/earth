'use client'

/**
 * The Active Room frame (SCREEN 14) shared by Humans (`RoomScreen`) and Guests (`GuestRoom`):
 * context header, the stage, the connection state, an optional join bar, the bottom controls.
 * Pure composition — every decision lives in the screen that renders it.
 */
import {
  type NamingParticipant,
  type RoomDto,
  type RoomParticipantDto,
  roomHeaderTitle,
  roomTitleKindFor,
} from '@earth/domain'
import type { ReactNode } from 'react'

import { ConnectionOverlay } from './ConnectionOverlay'
import { type RoomControlMode, RoomControls } from './RoomControls'
import { RoomHeader } from './RoomHeader'
import { RoomStage } from './RoomStage'
import type { MediaConnection } from './hooks/useMediaConnection'
import { isPublishing } from './state/consent'

export function toNamingParticipant(participant: RoomParticipantDto): NamingParticipant {
  return {
    id: participant.id,
    displayName: participant.displayName,
    isGuest: participant.isGuest,
    mediaState: participant.mediaState,
    status: participant.status,
    relation: participant.relationToViewer,
    joinedAt: participant.joinedAt,
  }
}

/** "Weekend Crew" or "Xavier + Kavon" (spec §60, viewer-aware). */
export function roomViewTitle(room: Pick<RoomDto, 'contextType' | 'contextTitle' | 'participants'>): string {
  return roomHeaderTitle({
    kind: roomTitleKindFor(room.contextType),
    contextTitle: room.contextTitle,
    participants: room.participants.map(toNamingParticipant),
  })
}

export interface RoomViewProps {
  readonly room: RoomDto
  readonly media: MediaConnection | null
  readonly mode: RoomControlMode
  readonly canOpenUp: boolean
  readonly busy?: boolean | undefined
  readonly headerTrailing?: ReactNode
  /** "Join them" for viewers / visitors; nothing for publishers. */
  readonly joinBar?: ReactNode
  /** One quiet line under the stage (permission problems, a failed change). */
  readonly notice?: string | null
  readonly onMic: () => void
  readonly onCamera: () => void
  readonly onFlip: () => void
  readonly onParticipants: () => void
  readonly onOpenUp: () => void
  readonly onMore: () => void
  readonly onLeave: () => void
  readonly onRetry: () => void
  readonly children?: ReactNode
}

export function RoomView(props: RoomViewProps) {
  const { room, media } = props
  const onStage = room.participants.filter(isPublishing)
  const watching = room.participants.filter((p) => p.status === 'active' && p.mediaState === 'watching').length
  return (
    <div className="flex h-dvh w-full flex-col bg-background text-text-primary">
      <RoomHeader
        title={roomViewTitle(room)}
        visibility={room.visibility}
        pendingVisibility={room.pendingVisibility}
        watchingCount={watching}
        trailing={props.headerTrailing}
      />
      <div className="relative flex min-h-0 flex-1 flex-col px-2">
        <RoomStage
          participants={onStage}
          livekitRoom={media?.livekitRoom ?? null}
          selfIdentity={media?.identity ?? null}
          facing={media?.facing ?? 'user'}
        />
        {media !== null ? (
          <ConnectionOverlay status={media.status} onRetry={props.onRetry} onLeave={props.onLeave} />
        ) : null}
      </div>
      {props.notice ? (
        <p role="status" className="px-screen-margin pt-2 text-secondary text-text-secondary">
          {props.notice}
        </p>
      ) : null}
      {props.joinBar}
      <RoomControls
        mode={props.mode}
        micOn={media?.micEnabled ?? false}
        cameraOn={media?.cameraEnabled ?? false}
        canOpenUp={props.canOpenUp}
        busy={props.busy}
        onMic={props.onMic}
        onCamera={props.onCamera}
        onFlip={props.onFlip}
        onParticipants={props.onParticipants}
        onOpenUp={props.onOpenUp}
        onMore={props.onMore}
        onLeave={props.onLeave}
      />
      {props.children}
    </div>
  )
}
