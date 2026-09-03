/**
 * The video stage (SCREEN 14): faces dominate, chrome minimal. Layout by count — 1 full,
 * 2 split, 3–4 grid, 5+ adaptive with the active speaker featured (`state/stage.ts`). The tiles
 * come from Earth's room reducer (`state/tiles.ts`, stable order across joins and leaves); the
 * LiveKit SDK only supplies tracks and speaking state, looked up by the media identity
 * (`h:<humanId>` / `g:<guestSessionId>`).
 */
import type { MediaIdentity } from '@earth/domain'
import { space, spacing } from '@earth/ui'
import {
  RoomContext,
  type TrackReference,
  useSpeakingParticipants,
  useTracks,
} from '@livekit/react-native'
import { type Room, Track } from 'livekit-client'
import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'

import type { FacingMode } from '@/features/rooms/hooks/useMediaConnection'
import {
  ADAPTIVE_STRIP_FRACTION,
  type StageLayout,
  featuredTileId,
  orderStageTiles,
  stageLayout,
} from '@/features/rooms/state/stage'
import type { RoomTile } from '@/features/rooms/state/tiles'

import { ParticipantTile, type StageParticipant } from './ParticipantTile'

export interface RoomStageProps {
  /** Publishers (audio / camera) in display order; viewers never appear on stage. */
  readonly tiles: readonly RoomTile[]
  readonly livekitRoom: Room | null
  readonly selfIdentity: MediaIdentity | null
  readonly facing: FacingMode
}

interface TrackLookup {
  readonly camera: ReadonlyMap<string, TrackReference>
  readonly micOn: ReadonlySet<string>
  readonly speaking: ReadonlySet<string>
}

const EMPTY_LOOKUP: TrackLookup = { camera: new Map(), micOn: new Set(), speaking: new Set() }

function toStageParticipants(
  tiles: readonly RoomTile[],
  selfIdentity: MediaIdentity | null,
  facing: FacingMode,
  lookup: TrackLookup,
): StageParticipant[] {
  return tiles.map((tile) => {
    const isSelf = tile.isSelf || tile.identity === selfIdentity
    const video = tile.mediaState === 'camera' ? (lookup.camera.get(tile.identity) ?? null) : null
    return {
      id: tile.id,
      identity: tile.identity,
      displayName: tile.displayName,
      avatarUrl: tile.avatarUrl,
      isGuest: tile.isGuest,
      isSelf,
      isSpeaking: lookup.speaking.has(tile.identity),
      micOn: lookup.micOn.has(tile.identity),
      videoTrack: video,
      hasVideo: video !== null,
      mirrored: isSelf && facing === 'user',
    }
  })
}

function StageGrid({ tiles }: { readonly tiles: readonly StageParticipant[] }) {
  const layout: StageLayout = stageLayout(tiles.length)
  const [featured, setFeatured] = useState<string | null>(null)
  const next = layout === 'adaptive' ? featuredTileId(tiles, featured) : null
  if (next !== featured) setFeatured(next)
  const ordered = orderStageTiles(tiles, next)

  if (layout === 'adaptive') {
    const [lead, ...rest] = ordered
    return (
      <View style={styles.stage}>
        {lead !== undefined ? <ParticipantTile participant={lead} featured /> : null}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.strip}
          contentContainerStyle={styles.stripContent}
        >
          {rest.map((tile) => (
            <ParticipantTile key={tile.id} participant={tile} style={styles.stripTile} />
          ))}
        </ScrollView>
      </View>
    )
  }
  if (layout === 'grid') {
    return (
      <View style={styles.gridStage}>
        {ordered.map((tile) => (
          <ParticipantTile key={tile.id} participant={tile} style={styles.gridTile} />
        ))}
      </View>
    )
  }
  return (
    <View style={styles.stage}>
      {ordered.map((tile) => (
        <ParticipantTile key={tile.id} participant={tile} featured={layout === 'single'} />
      ))}
    </View>
  )
}

function ConnectedStage(props: RoomStageProps) {
  const tracks = useTracks([Track.Source.Camera, Track.Source.Microphone], {
    onlySubscribed: false,
  })
  const speakers = useSpeakingParticipants()
  const camera = new Map<string, TrackReference>()
  const micOn = new Set<string>()
  for (const ref of tracks) {
    if (ref.source === Track.Source.Camera && !ref.publication.isMuted) {
      camera.set(ref.participant.identity, ref)
    }
    if (ref.source === Track.Source.Microphone && !ref.publication.isMuted) {
      micOn.add(ref.participant.identity)
    }
  }
  const speaking = new Set(speakers.map((participant) => participant.identity))
  const tiles = toStageParticipants(props.tiles, props.selfIdentity, props.facing, {
    camera,
    micOn,
    speaking,
  })
  return <StageGrid tiles={tiles} />
}

export function RoomStage(props: RoomStageProps) {
  if (props.livekitRoom === null) {
    const tiles = toStageParticipants(props.tiles, props.selfIdentity, props.facing, EMPTY_LOOKUP)
    return <StageGrid tiles={tiles} />
  }
  return (
    <RoomContext.Provider value={props.livekitRoom}>
      <ConnectedStage {...props} />
    </RoomContext.Provider>
  )
}

const STRIP_PERCENT = `${Math.round(ADAPTIVE_STRIP_FRACTION * 100)}%` as const

const styles = StyleSheet.create({
  stage: { flex: 1, minHeight: 0, gap: space[1], paddingHorizontal: space[2] },
  gridStage: {
    flex: 1,
    minHeight: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[1],
    paddingHorizontal: space[2],
  },
  gridTile: { flexBasis: '48%', flexGrow: 1, height: '49%' },
  strip: { flexGrow: 0, flexShrink: 0, height: STRIP_PERCENT },
  stripContent: { gap: space[1], paddingRight: spacing.screenMargin },
  stripTile: { width: 132 },
})
