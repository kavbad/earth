/**
 * One face: the camera track when there is one, otherwise the avatar; name and the subtle
 * Guest tag below (SCREEN 14, SCREEN 18). A speaking participant gets a quiet ring.
 */
import { borderWidth, colors, copy, radius, space } from '@earth/ui'
import { type TrackReference, VideoTrack } from '@livekit/react-native'
import { memo } from 'react'
import { StyleSheet, Text, View, type ViewStyle } from 'react-native'

import { Avatar } from '@/components/ui/Avatar'
import { Icon } from '@/components/ui/Icon'
import { text } from '@/components/ui/text'
import { roomCopy } from '@/features/rooms/copy'

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
  readonly style?: ViewStyle | undefined
}

function ParticipantTileView({ participant, featured = false, style }: ParticipantTileProps) {
  const label = participant.isSelf ? roomCopy.you : participant.displayName
  return (
    <View
      accessible
      accessibilityLabel={participant.isGuest ? `${label} (${copy.guest})` : label}
      style={[styles.tile, participant.isSpeaking && styles.speaking, style]}
    >
      {participant.videoTrack !== null ? (
        <VideoTrack
          trackRef={participant.videoTrack}
          style={styles.video}
          objectFit="cover"
          mirror={participant.mirrored}
          zOrder={participant.isSelf ? 1 : 0}
        />
      ) : (
        <Avatar
          name={participant.displayName}
          src={participant.avatarUrl}
          size={featured ? 'profile' : 'large'}
          decorative
        />
      )}
      <View style={styles.badge}>
        <Text style={[text.meta, text.primary, styles.name]} numberOfLines={1}>
          {label}
        </Text>
        {participant.isGuest ? <Text style={[text.meta, text.muted]}>{copy.guest}</Text> : null}
        {!participant.micOn ? (
          <Icon
            name="micOff"
            size="small"
            color={colors.textSecondary}
            label={copy.roomControls.microphone}
          />
        ) : null}
      </View>
    </View>
  )
}

export const ParticipantTile = memo(ParticipantTileView)

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: radius.medium,
    backgroundColor: colors.subtleFill,
    borderWidth: borderWidth.indicator,
    borderColor: 'transparent',
  },
  speaking: { borderColor: colors.textSecondary },
  video: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
  badge: {
    position: 'absolute',
    left: space[2],
    bottom: space[2],
    maxWidth: '90%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    paddingHorizontal: space[2],
    paddingVertical: space[1] / 2,
    borderRadius: radius.small,
    backgroundColor: colors.background,
    opacity: 0.92,
  },
  name: { flexShrink: 1 },
})
