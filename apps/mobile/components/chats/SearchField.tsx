/**
 * The search field at the top of Chats / New chat / Place (SCREEN 08 "Search at top"): subtle
 * fill, search glyph, no chrome. The one chat-surface primitive the shell does not provide.
 */
import { colors, radius, space, touchTarget } from '@earth/ui'
import { StyleSheet, TextInput, View } from 'react-native'

import { Icon, text } from '@/components/ui'

export interface SearchFieldProps {
  readonly value: string
  readonly onChangeText: (value: string) => void
  readonly placeholder: string
  readonly label: string
  readonly autoFocus?: boolean
}

export function SearchField({
  value,
  onChangeText,
  placeholder,
  label,
  autoFocus = false,
}: SearchFieldProps) {
  return (
    <View style={styles.box}>
      <Icon name="search" size="small" color={colors.textSecondary} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        clearButtonMode="while-editing"
        accessibilityLabel={label}
        accessibilityRole="search"
        style={[text.body, text.primary, styles.input]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[3],
    borderRadius: radius.medium,
    backgroundColor: colors.subtleFill,
  },
  input: { flex: 1, paddingVertical: space[2] },
})
