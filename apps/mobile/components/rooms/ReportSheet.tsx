/** Spec §82 reasons, exact labels from `@earth/ui`, one tap each. */
import { REPORT_REASON, type ReportReason } from '@earth/domain'
import { copy, space } from '@earth/ui'
import { ScrollView, StyleSheet, Text, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { ListRow } from '@/components/ui/ListRow'
import { Sheet } from '@/components/ui/Sheet'
import { text } from '@/components/ui/text'
import { roomCopy } from '@/features/rooms/copy'

export interface ReportSheetProps {
  readonly open: boolean
  readonly busy?: boolean
  readonly done?: boolean
  readonly onReport: (reason: ReportReason) => void
  readonly onClose: () => void
}

export function ReportSheet({
  open,
  busy = false,
  done = false,
  onReport,
  onClose,
}: ReportSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={roomCopy.reportTitle} closeButton>
      {done ? (
        <View style={styles.done}>
          <Text style={[text.body, text.primary]} accessibilityLiveRegion="polite">
            {roomCopy.reportSent}
          </Text>
          <Button variant="quiet" fullWidth label={copy.done} onPress={onClose} />
        </View>
      ) : (
        <ScrollView style={styles.list} bounces={false}>
          {REPORT_REASON.map((reason, index) => (
            <ListRow
              key={reason}
              flush
              title={copy.reportReasons[reason]}
              disabled={busy}
              separator={index < REPORT_REASON.length - 1}
              onPress={() => onReport(reason)}
            />
          ))}
        </ScrollView>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  done: { gap: space[4] },
  list: { maxHeight: 480 },
})
