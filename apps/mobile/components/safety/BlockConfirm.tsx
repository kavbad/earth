/**
 * Block (spec §21, §56, §81): a plain confirmation that says what changes — and that a shared
 * group keeps working for both. Calls `block_set`, tracks `human_blocked` (spec §97).
 */
import type { SourceSurface } from '@earth/analytics'
import type { BlockChangeDto } from '@earth/api'
import type { HumanId } from '@earth/domain'
import { copy, space } from '@earth/ui'
import { useCallback, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { Sheet } from '@/components/ui/Sheet'
import { text } from '@/components/ui/text'
import { safetyCopy } from '@/features/earth/copy'
import { lightTap } from '@/features/earth/haptics'
import { useEarthShell } from '@/features/earth/shell'

export interface BlockConfirmViewProps {
  readonly open: boolean
  readonly displayName: string
  readonly busy?: boolean
  readonly error?: string | null
  readonly onConfirm: () => void
  readonly onClose: () => void
}

/** Presentational confirmation (no providers), exported for reuse. */
export function BlockConfirmView({
  open,
  displayName,
  busy = false,
  error = null,
  onConfirm,
  onClose,
}: BlockConfirmViewProps) {
  return (
    <Sheet open={open} onClose={onClose} title={safetyCopy.blockTitle(displayName)}>
      <View style={styles.stack}>
        <Text style={[text.body, text.primary]}>{safetyCopy.blockBody(displayName)}</Text>
        <Text style={[text.secondary, text.muted]}>{safetyCopy.blockGroups}</Text>
        {error !== null ? (
          <Text style={[text.secondary, text.danger]} accessibilityLiveRegion="assertive">
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="destructive"
            fullWidth
            loading={busy}
            label={copy.safety.block}
            onPress={onConfirm}
          />
          <Button variant="quiet" fullWidth label={copy.notNow} onPress={onClose} />
        </View>
      </View>
    </Sheet>
  )
}

export interface BlockConfirmProps {
  readonly open: boolean
  readonly humanId: HumanId
  readonly displayName: string
  /** Where the block was asked for (`profile`, `post`, `room`, …) for `human_blocked`. */
  readonly source: SourceSurface
  readonly onClose: () => void
  readonly onBlocked?: ((change: BlockChangeDto) => void) | undefined
}

export function BlockConfirm({
  open,
  humanId,
  displayName,
  source,
  onClose,
  onBlocked,
}: BlockConfirmProps) {
  const { earth, track, toast } = useEarthShell()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = useCallback(async () => {
    if (busy) return
    lightTap()
    setBusy(true)
    setError(null)
    try {
      const change = await earth.social.block(humanId)
      track('human_blocked', { targetHumanId: humanId, source })
      toast(safetyCopy.blocked(displayName))
      onBlocked?.(change)
      onClose()
    } catch {
      setError(safetyCopy.couldnt)
    } finally {
      setBusy(false)
    }
  }, [busy, earth, track, toast, humanId, displayName, source, onBlocked, onClose])

  return (
    <BlockConfirmView
      open={open}
      displayName={displayName}
      busy={busy}
      error={error}
      onConfirm={() => void confirm()}
      onClose={onClose}
    />
  )
}

const styles = StyleSheet.create({
  stack: { gap: space[4] },
  actions: { gap: space[2] },
})
