/**
 * A labelled text field on the subtle fill with an optional hint, trailing note and error line
 * (the claim flow's names, handles and codes).
 */
import { borderWidth, colors, radius, space, touchTarget } from '@earth/ui'
import { StyleSheet, Text, TextInput, type TextInputProps, View } from 'react-native'

import { text } from './text'

export interface TextFieldProps {
  readonly label: string
  readonly value: string
  readonly onChangeText: (value: string) => void
  readonly hint?: string | undefined
  /** A short note at the end of the field (`Available`, `Checking…`). */
  readonly trailing?: string | undefined
  readonly error?: string | null | undefined
  readonly maxLength?: number
  readonly autoFocus?: boolean
  readonly hideLabel?: boolean
  readonly returnKeyType?: TextInputProps['returnKeyType']
  readonly onSubmitEditing?: () => void
  readonly keyboardType?: TextInputProps['keyboardType']
  readonly autoCapitalize?: TextInputProps['autoCapitalize']
  readonly autoComplete?: TextInputProps['autoComplete']
  readonly textContentType?: TextInputProps['textContentType']
  readonly autoCorrect?: boolean
  readonly editable?: boolean
}

export function TextField({
  label,
  value,
  onChangeText,
  hint,
  trailing,
  error,
  maxLength,
  autoFocus = false,
  hideLabel = false,
  returnKeyType = 'done',
  onSubmitEditing,
  keyboardType,
  autoCapitalize,
  autoComplete,
  textContentType,
  autoCorrect,
  editable = true,
}: TextFieldProps) {
  const errorText = error ?? null
  return (
    <View style={styles.box}>
      {hideLabel ? null : <Text style={[text.meta, text.muted]}>{label}</Text>}
      <View style={[styles.field, errorText !== null && styles.fieldError]}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          {...(maxLength === undefined ? {} : { maxLength })}
          autoFocus={autoFocus}
          returnKeyType={returnKeyType}
          {...(onSubmitEditing === undefined ? {} : { onSubmitEditing })}
          {...(keyboardType === undefined ? {} : { keyboardType })}
          {...(autoCapitalize === undefined ? {} : { autoCapitalize })}
          {...(autoComplete === undefined ? {} : { autoComplete })}
          {...(textContentType === undefined ? {} : { textContentType })}
          {...(autoCorrect === undefined ? {} : { autoCorrect })}
          editable={editable}
          placeholder={hideLabel ? label : undefined}
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel={label}
          {...(hint === undefined ? {} : { accessibilityHint: hint })}
          style={[text.body, text.primary, styles.input]}
        />
        {trailing !== undefined ? (
          <Text style={[text.meta, text.muted, styles.trailing]}>{trailing}</Text>
        ) : null}
      </View>
      {errorText !== null ? (
        <Text style={[text.meta, text.danger]} accessibilityLiveRegion="polite">
          {errorText}
        </Text>
      ) : hint !== undefined ? (
        <Text style={[text.meta, text.muted]}>{hint}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { gap: space[1] },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: touchTarget,
    borderRadius: radius.medium,
    backgroundColor: colors.subtleFill,
    paddingRight: space[3],
  },
  fieldError: { borderWidth: borderWidth.separator, borderColor: colors.danger },
  input: {
    flex: 1,
    minHeight: touchTarget,
    paddingHorizontal: space[4],
    paddingVertical: space[2],
  },
  trailing: { flexShrink: 0 },
})
