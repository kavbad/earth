/**
 * Bottom controls (SCREEN 14): microphone, camera, flip camera, participants, Open up, more,
 * leave. Leave is one quiet control among the others — never a giant red centre button.
 */
import {
  type IconName,
  borderWidth,
  colors,
  copy,
  radius,
  space,
  spacing,
  touchTarget,
} from '@earth/ui'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Icon } from '@/components/ui/Icon'
import { text } from '@/components/ui/text'

export const ROOM_CONTROL_MODES = ['visitor', 'viewer', 'participant'] as const
export type RoomControlMode = (typeof ROOM_CONTROL_MODES)[number]

export interface RoomControlsProps {
  readonly mode: RoomControlMode
  readonly micOn: boolean
  readonly cameraOn: boolean
  /** Initiator / moderator only (spec §58): the Open up control. */
  readonly canOpenUp: boolean
  readonly busy?: boolean | undefined
  readonly onMic: () => void
  readonly onCamera: () => void
  readonly onFlip: () => void
  readonly onParticipants: () => void
  readonly onOpenUp: () => void
  readonly onMore: () => void
  readonly onLeave: () => void
}

function ControlButton({
  icon,
  label,
  pressed,
  onPress,
  disabled = false,
}: {
  readonly icon: IconName
  readonly label: string
  readonly pressed?: boolean
  readonly onPress: () => void
  readonly disabled?: boolean | undefined
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, ...(pressed === undefined ? {} : { selected: pressed }) }}
      style={({ pressed: down }) => [
        styles.control,
        disabled && styles.disabled,
        down && styles.down,
      ]}
    >
      <Icon name={icon} color={pressed === false ? colors.textSecondary : colors.textPrimary} />
    </Pressable>
  )
}

export function RoomControls(props: RoomControlsProps) {
  const insets = useSafeAreaInsets()
  const publishing = props.mode === 'participant'
  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom + space[2] }]}>
      {publishing ? (
        <>
          <ControlButton
            icon={props.micOn ? 'mic' : 'micOff'}
            label={copy.roomControls.microphone}
            pressed={props.micOn}
            onPress={props.onMic}
            disabled={props.busy}
          />
          <ControlButton
            icon={props.cameraOn ? 'camera' : 'cameraOff'}
            label={copy.roomControls.camera}
            pressed={props.cameraOn}
            onPress={props.onCamera}
            disabled={props.busy}
          />
          {props.cameraOn ? (
            <ControlButton
              icon="flip"
              label={copy.roomControls.flipCamera}
              onPress={props.onFlip}
            />
          ) : null}
        </>
      ) : null}
      {props.mode !== 'visitor' ? (
        <ControlButton
          icon="participants"
          label={copy.roomControls.participants}
          onPress={props.onParticipants}
        />
      ) : null}
      {props.canOpenUp ? (
        <Pressable
          onPress={props.onOpenUp}
          accessibilityRole="button"
          accessibilityLabel={copy.openUp}
          style={({ pressed }) => [styles.openUp, pressed && styles.down]}
        >
          <Text style={[text.bodyMedium, text.primary]}>{copy.openUp}</Text>
        </Pressable>
      ) : null}
      {props.mode !== 'visitor' ? (
        <ControlButton icon="more" label={copy.roomControls.more} onPress={props.onMore} />
      ) : null}
      <ControlButton icon="leave" label={copy.roomControls.leave} onPress={props.onLeave} />
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[1],
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[2],
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.separator,
    backgroundColor: colors.background,
  },
  control: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radius.avatar,
    alignItems: 'center',
    justifyContent: 'center',
  },
  openUp: {
    minHeight: touchTarget,
    paddingHorizontal: space[3],
    borderRadius: radius.medium,
    justifyContent: 'center',
  },
  disabled: { opacity: 0.5 },
  down: { backgroundColor: colors.subtleFill },
})
