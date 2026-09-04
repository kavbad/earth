/**
 * Spec §82 reasons, exact labels from `@earth/ui`, one tap each (posts and profiles), then a
 * quiet confirmation.
 */
import { REPORT_REASON, type ReportReason } from '@earth/domain'
import { copy, space } from '@earth/ui'
import { StyleSheet, Text, View } from 'react-native'

import { Button, ListRow, Sheet, text } from '@/components/ui'

export interface ReportSheetProps {
  readonly open: boolean
  readonly title: string
  readonly sentText: string
  readonly busy?: boolean
  readonly done?: boolean
  readonly onReport: (reason: ReportReason) => void
  readonly onClose: () => void
}

export function ReportSheet({
  open,
  title,
  sentText,
  busy = false,
  done = false,
  onReport,
  onClose,
}: ReportSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={title} closeButton scroll>
      {done ? (
        <View style={styles.done}>
          <Text style={[text.body, text.primary]} accessibilityLiveRegion="polite">
            {sentText}
          </Text>
          <Button variant="quiet" fullWidth label={copy.done} onPress={onClose} />
        </View>
      ) : (
        <View>
          {REPORT_REASON.map((reason, index) => (
            <ListRow
              key={reason}
              title={copy.reportReasons[reason]}
              disabled={busy}
              onPress={() => onReport(reason)}
              flush
              separator={index < REPORT_REASON.length - 1}
            />
          ))}
        </View>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  done: { gap: space[4] },
})
