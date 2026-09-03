/**
 * Spec §109 over the stage: "Reconnecting…" while the SDK or Earth retries; "Couldn't reconnect"
 * with "Try again" / "Leave" once the policy is exhausted. Spec §107: Live needs network, and
 * the overlay says "Connection unavailable" rather than a generic error while the device is off.
 */
import { colors, copy, space, spacing, zIndex } from '@earth/ui'
import { StyleSheet, Text, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { text } from '@/components/ui/text'
import { useRoomShell } from '@/features/rooms/shell'
import { type MediaStatus, connectionOverlay } from '@/features/rooms/state/connection'

export interface ConnectionOverlayProps {
  readonly status: MediaStatus
  readonly onRetry: () => void
  readonly onLeave: () => void
}

export function ConnectionOverlay({ status, onRetry, onLeave }: ConnectionOverlayProps) {
  const { online } = useRoomShell()
  const state = connectionOverlay(status, online)
  if (state.line === null) return null
  return (
    <View style={styles.overlay} accessibilityLiveRegion="polite">
      <View style={styles.line}>
        {state.spinner ? <Spinner label={state.line} /> : null}
        <Text style={[text.secondary, text.primary]}>{state.line}</Text>
      </View>
      {state.actions ? (
        <View style={styles.actions}>
          <Button variant="primary" label={copy.tryAgain} onPress={onRetry} />
          <Button variant="quiet" label={copy.leave} onPress={onLeave} />
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: zIndex.overlay,
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[4],
    backgroundColor: colors.background,
    opacity: 0.94,
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: space[2] },
  actions: { flexDirection: 'row', gap: space[2] },
})
