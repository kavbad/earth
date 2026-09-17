/**
 * The Active Room frame (SCREEN 14): context header, the stage, the connection state, an optional
 * join bar, the bottom controls. Pure composition — every decision lives in `RoomScreen`.
 */
import {
  type NamingParticipant,
  type RoomDto,
  type RoomParticipantDto,
  roomHeaderTitle,
  roomTitleKindFor,
} from '@earth/domain'
import { colors, copy } from '@earth/ui'
import type { ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'

import { StatusLine } from '@/components/ui/StatusLine'
import type { MediaConnection } from '@/features/rooms/hooks/useMediaConnection'
import { useRoomShell } from '@/features/rooms/shell'
import { watchingCount } from '@/features/rooms/state/consent'
import type { RoomTile } from '@/features/rooms/state/tiles'

import { ConnectionOverlay } from './ConnectionOverlay'
import { type RoomControlMode, RoomControls } from './RoomControls'
import { RoomHeader } from './RoomHeader'
import { RoomStage } from './RoomStage'

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
export function roomViewTitle(
  room: Pick<RoomDto, 'contextType' | 'contextTitle' | 'participants'>,
): string {
  return roomHeaderTitle({
    kind: roomTitleKindFor(room.contextType),
    contextTitle: room.contextTitle,
    participants: room.participants.map(toNamingParticipant),
  })
}

export interface RoomViewProps {
  readonly room: RoomDto
  /** Stage tiles from the room reducer, in display order. */
  readonly tiles: readonly RoomTile[]
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
  const { online } = useRoomShell()
  return (
    <View style={styles.root}>
      <RoomHeader
        title={roomViewTitle(room)}
        visibility={room.visibility}
        pendingVisibility={room.pendingVisibility}
        watchingCount={watchingCount(room)}
        trailing={props.headerTrailing}
      />
      {/* Without a media connection (Visitors) the overlay below never speaks: say it here (spec §107). */}
      {media === null && !online ? (
        <StatusLine banner message={copy.connectionUnavailable} />
      ) : null}
      <View style={styles.stageArea}>
        <RoomStage
          tiles={props.tiles}
          livekitRoom={media?.livekitRoom ?? null}
          selfIdentity={media?.identity ?? null}
          facing={media?.facing ?? 'user'}
        />
        {media !== null ? (
          <ConnectionOverlay
            status={media.status}
            onRetry={props.onRetry}
            onLeave={props.onLeave}
          />
        ) : null}
      </View>
      {props.notice ? <StatusLine message={props.notice} /> : null}
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
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  stageArea: { flex: 1, minHeight: 0 },
})
