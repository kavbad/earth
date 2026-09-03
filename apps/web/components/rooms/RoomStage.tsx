'use client'

/**
 * The video stage (SCREEN 14): faces dominate, chrome minimal. Layout by count — 1 full,
 * 2 split, 3–4 grid, 5+ adaptive with the active speaker featured (`state/stage.ts`). Earth's
 * `RoomDto` participants are the source of truth; the LiveKit SDK only supplies tracks and
 * speaking state, looked up by the media identity (`h:<humanId>` / `g:<guestSessionId>`).
 */
import {
  type MediaIdentity,
  type RoomParticipantDto,
  mediaIdentityForGuest,
  mediaIdentityForHuman,
} from '@earth/domain'
import type { TrackReference } from '@livekit/components-core'
import {
  RoomAudioRenderer,
  RoomContext,
  useSpeakingParticipants,
  useTracks,
} from '@livekit/components-react'
import { type Room, Track } from 'livekit-client'
import { useState } from 'react'

import { cx } from '../ui/cx'
import { ParticipantTile, type StageParticipant } from './ParticipantTile'
import type { FacingMode } from './hooks/useMediaConnection'
import { type StageLayout, featuredTileId, orderStageTiles, stageLayout } from './state/stage'

export interface RoomStageProps {
  /** Active publishers (audio / camera); viewers never appear on stage. */
  readonly participants: readonly RoomParticipantDto[]
  readonly livekitRoom: Room | null
  readonly selfIdentity: MediaIdentity | null
  readonly facing: FacingMode
  readonly className?: string | undefined
}

export function participantIdentity(participant: RoomParticipantDto): MediaIdentity | null {
  if (participant.humanId !== null) return mediaIdentityForHuman(participant.humanId)
  if (participant.guestSessionId !== null) return mediaIdentityForGuest(participant.guestSessionId)
  return null
}

interface TrackLookup {
  readonly camera: ReadonlyMap<string, TrackReference>
  readonly micOn: ReadonlySet<string>
  readonly speaking: ReadonlySet<string>
}

const EMPTY_LOOKUP: TrackLookup = { camera: new Map(), micOn: new Set(), speaking: new Set() }

function toStageParticipants(
  participants: readonly RoomParticipantDto[],
  selfIdentity: MediaIdentity | null,
  facing: FacingMode,
  lookup: TrackLookup,
): StageParticipant[] {
  const tiles: StageParticipant[] = []
  for (const participant of participants) {
    const identity = participantIdentity(participant)
    if (identity === null) continue
    const isSelf = identity === selfIdentity
    const video = participant.mediaState === 'camera' ? (lookup.camera.get(identity) ?? null) : null
    tiles.push({
      id: participant.id,
      identity,
      displayName: participant.displayName,
      avatarUrl: participant.avatarUrl,
      isGuest: participant.isGuest,
      isSelf,
      isSpeaking: lookup.speaking.has(identity),
      micOn: lookup.micOn.has(identity),
      videoTrack: video,
      hasVideo: video !== null,
      mirrored: isSelf && facing === 'user',
    })
  }
  return tiles
}

const LAYOUT_CLASS: Record<StageLayout, string> = {
  empty: 'grid-cols-1',
  single: 'grid-cols-1 grid-rows-1',
  split: 'grid-cols-1 grid-rows-2 landscape:grid-cols-2 landscape:grid-rows-1',
  grid: 'grid-cols-2 grid-rows-2',
  adaptive: 'grid-cols-1',
}

function StageGrid({
  tiles,
  className,
}: {
  tiles: readonly StageParticipant[]
  className?: string | undefined
}) {
  const layout = stageLayout(tiles.length)
  const [featured, setFeatured] = useState<string | null>(null)
  const next = layout === 'adaptive' ? featuredTileId(tiles, featured) : null
  if (next !== featured) setFeatured(next)
  const ordered = orderStageTiles(tiles, next)

  if (layout === 'adaptive') {
    const [lead, ...rest] = ordered
    return (
      <div className={cx('flex min-h-0 flex-1 flex-col gap-1', className)}>
        {lead !== undefined ? (
          <ParticipantTile participant={lead} featured className="min-h-0 flex-1" />
        ) : null}
        <div className="grid h-[28%] shrink-0 auto-cols-[minmax(33%,1fr)] grid-flow-col gap-1 overflow-x-auto">
          {rest.map((tile) => (
            <ParticipantTile key={tile.id} participant={tile} />
          ))}
        </div>
      </div>
    )
  }
  return (
    <div className={cx('grid min-h-0 flex-1 gap-1', LAYOUT_CLASS[layout], className)}>
      {ordered.map((tile) => (
        <ParticipantTile key={tile.id} participant={tile} featured={layout === 'single'} />
      ))}
    </div>
  )
}

function ConnectedStage(props: RoomStageProps) {
  const cameraTracks = useTracks([Track.Source.Camera, Track.Source.Microphone], {
    onlySubscribed: false,
  })
  const speakers = useSpeakingParticipants()
  const camera = new Map<string, TrackReference>()
  const micOn = new Set<string>()
  for (const ref of cameraTracks) {
    if (ref.source === Track.Source.Camera && !ref.publication.isMuted) {
      camera.set(ref.participant.identity, ref)
    }
    if (ref.source === Track.Source.Microphone && !ref.publication.isMuted) {
      micOn.add(ref.participant.identity)
    }
  }
  const speaking = new Set(speakers.map((p) => p.identity))
  const tiles = toStageParticipants(props.participants, props.selfIdentity, props.facing, {
    camera,
    micOn,
    speaking,
  })
  return (
    <>
      <StageGrid tiles={tiles} className={props.className} />
      <RoomAudioRenderer />
    </>
  )
}

export function RoomStage(props: RoomStageProps) {
  if (props.livekitRoom === null) {
    const tiles = toStageParticipants(
      props.participants,
      props.selfIdentity,
      props.facing,
      EMPTY_LOOKUP,
    )
    return <StageGrid tiles={tiles} className={props.className} />
  }
  return (
    <RoomContext.Provider value={props.livekitRoom}>
      <ConnectedStage {...props} />
    </RoomContext.Provider>
  )
}
