/**
 * The "more" sheet: share link (the system share sheet), Guests on/off and End room for
 * moderators, report, leave. The Guests row only exists while `GUEST_ROOMS_ENABLED` is on.
 */
import { copy, space } from '@earth/ui'
import { useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { ListRow } from '@/components/ui/ListRow'
import { Sheet } from '@/components/ui/Sheet'
import { text } from '@/components/ui/text'
import { roomCopy } from '@/features/rooms/copy'

export interface MoreSheetProps {
  readonly open: boolean
  readonly canModerate: boolean
  readonly guestsDisabled: boolean
  /** `GUEST_ROOMS_ENABLED` (spec §118): without it there is no Guests row. */
  readonly guestsEnabled?: boolean
  readonly busy?: boolean
  readonly onShare: () => void
  readonly onToggleGuests: () => void
  readonly onEnd: () => void
  readonly onReport: () => void
  readonly onLeave: () => void
  readonly onClose: () => void
}

export function MoreSheet(props: MoreSheetProps) {
  const [confirmingEnd, setConfirmingEnd] = useState(false)
  const guestsEnabled = props.guestsEnabled ?? true
  const close = () => {
    setConfirmingEnd(false)
    props.onClose()
  }
  return (
    <Sheet open={props.open} onClose={close} title={copy.roomControls.more} closeButton>
      {confirmingEnd ? (
        <View style={styles.confirm}>
          <Text style={[text.body, text.primary]}>{roomCopy.endRoomConfirm}</Text>
          <View style={styles.actions}>
            <Button
              variant="primary"
              fullWidth
              loading={props.busy ?? false}
              label={roomCopy.endRoomYes}
              onPress={props.onEnd}
            />
            <Button
              variant="quiet"
              fullWidth
              label={copy.notNow}
              onPress={() => setConfirmingEnd(false)}
            />
          </View>
        </View>
      ) : (
        <View style={styles.rows}>
          <ListRow
            flush
            title={copy.shareLink}
            disabled={props.busy ?? false}
            onPress={props.onShare}
          />
          {props.canModerate && guestsEnabled ? (
            <ListRow
              flush
              title={props.guestsDisabled ? roomCopy.allowGuests : copy.safety.disableGuests}
              disabled={props.busy ?? false}
              onPress={props.onToggleGuests}
            />
          ) : null}
          {props.canModerate ? (
            <ListRow
              flush
              title={copy.safety.endRoom}
              destructive
              onPress={() => setConfirmingEnd(true)}
            />
          ) : null}
          <ListRow flush title={copy.safety.report} onPress={props.onReport} />
          <ListRow flush title={copy.leave} separator={false} onPress={props.onLeave} />
          <Button variant="quiet" fullWidth label={roomCopy.close} onPress={close} />
        </View>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  confirm: { gap: space[4] },
  actions: { gap: space[2] },
  rows: { gap: space[1] },
})
