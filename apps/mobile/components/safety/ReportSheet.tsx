/**
 * Report (spec §81–§82): the exact reasons in the spec's order, one tap each, then a quiet
 * confirmation. Works for every target type (`human`, `post`, `room`, `message`, `guest`,
 * `group`) and for Guests reporting their room. Tracks `content_reported` (spec §97).
 */
import {
  REPORT_REASON,
  type ReportDto,
  type ReportReason,
  type ReportTargetType,
} from '@earth/domain'
import { copy, space } from '@earth/ui'
import { useCallback, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { ListRow } from '@/components/ui/ListRow'
import { Sheet } from '@/components/ui/Sheet'
import { text } from '@/components/ui/text'
import { safetyCopy } from '@/features/earth/copy'
import { lightTap } from '@/features/earth/haptics'
import { useEarthShell } from '@/features/earth/shell'

export interface ReportSheetViewProps {
  readonly open: boolean
  readonly title?: string
  readonly busy?: boolean
  readonly done?: boolean
  readonly error?: string | null
  readonly onReason: (reason: ReportReason) => void
  readonly onClose: () => void
}

/** Presentational sheet (no providers) — rendered by `ReportSheet`, exported for reuse. */
export function ReportSheetView({
  open,
  title = safetyCopy.reportTitle,
  busy = false,
  done = false,
  error = null,
  onReason,
  onClose,
}: ReportSheetViewProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title} closeButton scroll>
      {done ? (
        <View style={styles.done}>
          <Text style={[text.body, text.primary]} accessibilityLiveRegion="polite">
            {safetyCopy.reportSent}
          </Text>
          <Button variant="quiet" fullWidth label={copy.done} onPress={onClose} />
        </View>
      ) : (
        <View style={styles.stack}>
          <View>
            {REPORT_REASON.map((reason, index) => (
              <ListRow
                key={reason}
                flush
                title={copy.reportReasons[reason]}
                disabled={busy}
                separator={index < REPORT_REASON.length - 1}
                onPress={() => onReason(reason)}
              />
            ))}
          </View>
          <Text style={[text.secondary, text.muted]}>{safetyCopy.reportHint}</Text>
          {error !== null ? (
            <Text style={[text.secondary, text.danger]} accessibilityLiveRegion="assertive">
              {error}
            </Text>
          ) : null}
        </View>
      )}
    </Sheet>
  )
}

export interface ReportSheetProps {
  readonly open: boolean
  readonly targetType: ReportTargetType
  readonly targetId: string
  readonly title?: string
  readonly onClose: () => void
  readonly onReported?: ((report: ReportDto) => void) | undefined
}

export function ReportSheet({
  open,
  targetType,
  targetId,
  title,
  onClose,
  onReported,
}: ReportSheetProps) {
  const { earth, track } = useEarthShell()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = useCallback(() => {
    setDone(false)
    setError(null)
    onClose()
  }, [onClose])

  const report = useCallback(
    async (reason: ReportReason) => {
      if (busy) return
      lightTap()
      setBusy(true)
      setError(null)
      try {
        const result = await earth.safety.report({ targetType, targetId, reason, details: null })
        track('content_reported', { targetType, reason })
        setDone(true)
        onReported?.(result)
      } catch {
        setError(safetyCopy.couldnt)
      } finally {
        setBusy(false)
      }
    },
    [busy, earth, track, targetType, targetId, onReported],
  )

  return (
    <ReportSheetView
      open={open}
      {...(title === undefined ? {} : { title })}
      busy={busy}
      done={done}
      error={error}
      onReason={(reason) => void report(reason)}
      onClose={close}
    />
  )
}

const styles = StyleSheet.create({
  done: { gap: space[4] },
  stack: { gap: space[3] },
})
