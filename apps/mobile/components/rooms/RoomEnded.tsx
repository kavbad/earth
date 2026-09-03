/**
 * The quiet end state: one line and a way back — never a giant error (spec §110 spirit). A room
 * that could not be opened while the device is offline says "Connection unavailable" (spec §107:
 * Live requires network and says so), not a generic failure.
 */
import { copy, space, spacing } from '@earth/ui'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Button } from '@/components/ui/Button'
import { text } from '@/components/ui/text'
import { roomCopy } from '@/features/rooms/copy'
import { useRoomShell } from '@/features/rooms/shell'
import { type RoomClosedKind, roomClosedLine } from '@/features/rooms/state/closed'

export interface RoomEndedProps {
  readonly kind: RoomClosedKind
  readonly onBack: () => void
  readonly onRetry?: () => void
}

export function RoomEnded({ kind, onBack, onRetry }: RoomEndedProps) {
  const insets = useSafeAreaInsets()
  const { online } = useRoomShell()
  const line = roomClosedLine(kind, online)
  return (
    <View style={[styles.box, { paddingTop: insets.top + space[8], paddingBottom: insets.bottom }]}>
      <Text style={[text.section, text.primary]} accessibilityLiveRegion="polite">
        {line}
      </Text>
      <View style={styles.actions}>
        {kind === 'error' && onRetry !== undefined ? (
          <Button variant="primary" label={copy.tryAgain} onPress={onRetry} />
        ) : null}
        <Button variant="quiet" label={roomCopy.backToLive} onPress={onBack} />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    flex: 1,
    justifyContent: 'center',
    gap: space[4],
    paddingHorizontal: spacing.screenMargin,
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
})
