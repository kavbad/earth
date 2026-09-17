/**
 * SCREEN 06: the stronger — not scary — confirmation when a post moves materially outward from
 * what the person usually posts to. Shown once per composer per audience.
 */
import type { Audience } from '@earth/domain'
import { copy, space } from '@earth/ui'
import { StyleSheet, Text, View } from 'react-native'

import { postCopy } from '@/features/feed/copy'

import { Button, Sheet, text } from '@/components/ui'

export interface AudienceConfirmSheetProps {
  /** The audience waiting for confirmation; the sheet is closed when `null`. */
  readonly pending: Audience | null
  /** What the person usually posts to (the member default when unknown). */
  readonly usual: Audience
  /** The audience the composer keeps if they decline. */
  readonly current: Audience
  readonly onConfirm: () => void
  readonly onCancel: () => void
}

export function AudienceConfirmSheet({
  pending,
  usual,
  current,
  onConfirm,
  onCancel,
}: AudienceConfirmSheetProps) {
  const label = pending === null ? '' : copy.audiences[pending]
  const usualLabel = copy.audiences[usual]
  return (
    <Sheet open={pending !== null} onClose={onCancel} title={postCopy.confirmTitle(label)}>
      <Text style={[text.body, text.muted, styles.body]}>
        {pending === 'world'
          ? postCopy.confirmWorldBody(usualLabel)
          : postCopy.confirmBody(label, usualLabel)}
      </Text>
      <View style={styles.actions}>
        <Button fullWidth label={postCopy.postTo(label)} onPress={onConfirm} />
        <Button
          variant="quiet"
          fullWidth
          label={postCopy.keepUsual(copy.audiences[current])}
          onPress={onCancel}
        />
      </View>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  body: { marginBottom: space[4] },
  actions: { gap: space[2] },
})
