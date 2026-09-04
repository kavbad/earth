/**
 * "Here" (SCREEN 10 plus sheet): precise location sharing is bounded and lives on the Earth map
 * (spec §75 "Share with Weekend Crew", 1 hour / Tonight / Custom). This sheet names the
 * durations and hands off to the map — location-sharing writes never happen from a chat. It
 * stands in for the earth agent's location share sheet until that component exists.
 */
import { copy, space } from '@earth/ui'
import { useRouter } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'

import { chatCopy } from '@/features/chats/copy'
import { earthShareHref } from '@/features/chats/routes'

import { Button, Sheet, text } from '@/components/ui'

export interface HereSheetProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly conversationId: string
  readonly conversationTitle: string
}

export function HereSheet({ open, onClose, conversationId, conversationTitle }: HereSheetProps) {
  const router = useRouter()
  return (
    <Sheet open={open} onClose={onClose} title={copy.shareWith(conversationTitle)} closeButton>
      <Text style={[text.body, text.muted]}>{chatCopy.hereBody}</Text>
      <View
        style={styles.durations}
        accessibilityRole="list"
        accessibilityLabel={copy.composerActions.here}
      >
        <Text style={[text.secondary, text.muted]}>{copy.durations.oneHour}</Text>
        <Text style={[text.secondary, text.muted]}>{copy.durations.tonight}</Text>
        <Text style={[text.secondary, text.muted]}>{copy.durations.custom}</Text>
      </View>
      <Button
        label={chatCopy.shareOnEarth}
        fullWidth
        style={styles.action}
        onPress={() => {
          onClose()
          router.push(earthShareHref(conversationId))
        }}
      />
    </Sheet>
  )
}

const styles = StyleSheet.create({
  durations: { flexDirection: 'row', gap: space[4], marginTop: space[3] },
  action: { marginTop: space[5] },
})
