/**
 * SCREEN 16 — exact copy from `@earth/ui`: "Xavier's room is visible to World. If you join on
 * camera, people on Earth may see that you're here." Buttons: Join on camera / Join audio only /
 * Just watch. No hidden audience inheritance.
 */
import type { MediaState, RoomVisibility } from '@earth/domain'
import { CONSENT_CHOICES, copy, space } from '@earth/ui'
import { StyleSheet, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { roomCopy } from '@/features/rooms/copy'

export interface ConsentSheetProps {
  readonly open: boolean
  readonly initiatorName: string | null
  readonly level: RoomVisibility
  readonly busy?: boolean
  readonly onChoose: (mediaState: MediaState) => void
  readonly onClose: () => void
}

export function ConsentSheet({
  open,
  initiatorName,
  level,
  busy = false,
  onChoose,
  onClose,
}: ConsentSheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={copy.consent(initiatorName ?? roomCopy.someone, level)}
    >
      <View style={styles.choices}>
        {CONSENT_CHOICES.map((choice, index) => (
          <Button
            key={choice.mediaState}
            variant={index === 0 ? 'primary' : index === 1 ? 'secondary' : 'quiet'}
            fullWidth
            loading={busy && index === 0}
            disabled={busy}
            label={choice.label}
            onPress={() => onChoose(choice.mediaState)}
          />
        ))}
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  choices: { gap: space[2] },
})
