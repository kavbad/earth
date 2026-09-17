/**
 * SCREEN 06 audience picker: Friends · Neighborhood · City · World as plain rows, the current one
 * checked. A reply only offers what stays within the root's audience (spec §72).
 */
import type { Audience } from '@earth/domain'
import { colors, copy, space } from '@earth/ui'
import { StyleSheet, Text, View } from 'react-native'

import { postCopy } from '@/features/feed/copy'
import { selectionTap } from '@/lib/haptics'

import { Icon, ListRow, Sheet, text } from '@/components/ui'

export interface AudienceSheetProps {
  readonly open: boolean
  readonly value: Audience
  readonly options: readonly Audience[]
  readonly cap: Audience | null
  readonly onSelect: (audience: Audience) => void
  readonly onClose: () => void
}

export function AudienceSheet({
  open,
  value,
  options,
  cap,
  onSelect,
  onClose,
}: AudienceSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={postCopy.audienceTitle} closeButton>
      <View>
        {options.map((audience, index) => (
          <ListRow
            key={audience}
            title={copy.audiences[audience]}
            accessibilityRole="radio"
            selected={audience === value}
            trailing={
              audience === value ? (
                <Icon name="check" size="small" color={colors.textPrimary} />
              ) : undefined
            }
            onPress={() => {
              selectionTap()
              onSelect(audience)
              onClose()
            }}
            flush
            separator={index < options.length - 1}
          />
        ))}
      </View>
      {cap !== null ? (
        <Text style={[text.secondary, text.muted, styles.cap]}>
          {postCopy.audienceCapped(copy.audiences[cap])}
        </Text>
      ) : null}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  cap: { marginTop: space[3] },
})
