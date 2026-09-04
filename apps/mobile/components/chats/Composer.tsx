/**
 * The composer (SCREEN 10): `+ Message… microphone camera`. Twelve icons never show; the plus
 * opens a sheet. Typing swaps the microphone for send. Voice recording takes the row over with
 * elapsed time, cancel and stop-and-send. A light haptic on send.
 */
import { borderWidth, colors, radius, space, touchTarget } from '@earth/ui'
import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { chatCopy } from '@/features/chats/copy'
import { lightTap } from '@/lib/haptics'
import { formatDuration } from '@/features/chats/payloads'
import type { ChatMessage } from '@/features/chats/state/messages'

import { IconButton, text } from '@/components/ui'

export const COMPOSER_MAX_HEIGHT = 136

export interface ComposerRecording {
  readonly active: boolean
  readonly elapsedMs: number
  readonly supported: boolean
  readonly start: () => void
  readonly stop: () => void
  readonly cancel: () => void
}

export interface ComposerProps {
  readonly disabled?: boolean
  readonly replyTo: ChatMessage | null
  readonly replyToName: string
  readonly onCancelReply: () => void
  readonly onSendText: (text: string) => void
  readonly onTyping: () => void
  readonly onPlus: () => void
  readonly onCamera: () => void
  readonly cameraLabel: string
  readonly cameraBusy?: boolean
  readonly recording: ComposerRecording
  /** A media upload in flight (the line above the row). */
  readonly uploading: boolean
  /** Whether the keyboard inset is handled by the screen (the safe-area bottom padding stays). */
  readonly placeholder: string
}

export function Composer({
  disabled = false,
  replyTo,
  replyToName,
  onCancelReply,
  onSendText,
  onTyping,
  onPlus,
  onCamera,
  cameraLabel,
  cameraBusy = false,
  recording,
  uploading,
  placeholder,
}: ComposerProps) {
  const insets = useSafeAreaInsets()
  const [value, setValue] = useState('')
  const input = useRef<TextInput>(null)

  useEffect(() => {
    if (replyTo !== null) input.current?.focus()
  }, [replyTo])

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed.length === 0 || disabled) return
    lightTap()
    onSendText(trimmed)
    setValue('')
  }

  const onChangeText = (next: string) => {
    setValue(next)
    if (next.trim().length > 0) onTyping()
  }

  const hasText = value.trim().length > 0

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space[2]) }]}>
      {uploading ? (
        <View style={styles.note} accessibilityLiveRegion="polite" accessible>
          <ActivityIndicator size="small" color={colors.textSecondary} />
          <Text style={[text.meta, text.muted]}>{chatCopy.uploading}</Text>
        </View>
      ) : null}
      {replyTo !== null ? (
        <View style={styles.reply}>
          <Text style={[text.secondary, text.muted, styles.replyText]} numberOfLines={1}>
            {chatCopy.replyTo(replyToName)}
          </Text>
          <IconButton
            name="close"
            label={chatCopy.cancelReply}
            onPress={onCancelReply}
            color={colors.textSecondary}
          />
        </View>
      ) : null}
      {recording.active ? (
        <View style={styles.row}>
          <IconButton name="close" label={chatCopy.cancelRecording} onPress={recording.cancel} />
          <View style={styles.recording} accessibilityLiveRegion="polite" accessible>
            <View style={styles.recordingDot} />
            <Text style={[text.body, text.primary]}>
              {chatCopy.recording} {formatDuration(recording.elapsedMs)}
            </Text>
          </View>
          <IconButton name="send" label={chatCopy.stopRecording} onPress={recording.stop} filled />
        </View>
      ) : (
        <View style={styles.row}>
          <IconButton name="plus" label={chatCopy.attach} onPress={onPlus} disabled={disabled} />
          <TextInput
            ref={input}
            value={value}
            onChangeText={onChangeText}
            editable={!disabled}
            multiline
            placeholder={placeholder}
            placeholderTextColor={colors.textSecondary}
            accessibilityLabel={placeholder}
            style={[text.body, text.primary, styles.input, disabled && styles.inputDisabled]}
          />
          {hasText ? (
            <IconButton
              name="send"
              label={chatCopy.send}
              onPress={submit}
              disabled={disabled}
              filled
            />
          ) : (
            <>
              <IconButton
                name="mic"
                label={chatCopy.voiceMessage}
                onPress={recording.start}
                disabled={disabled || !recording.supported}
              />
              <IconButton
                name="camera"
                label={cameraLabel}
                onPress={onCamera}
                disabled={disabled || cameraBusy}
                busy={cameraBusy}
              />
            </>
          )}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.background,
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.separator,
    paddingHorizontal: space[2],
    paddingTop: space[2],
  },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[2],
    paddingBottom: space[1],
  },
  reply: { flexDirection: 'row', alignItems: 'center', gap: space[2], paddingLeft: space[2] },
  replyText: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space[1] },
  input: {
    flex: 1,
    minHeight: touchTarget - space[1],
    maxHeight: COMPOSER_MAX_HEIGHT,
    paddingHorizontal: space[4],
    paddingTop: space[2],
    paddingBottom: space[2],
    borderRadius: radius.medium,
    backgroundColor: colors.subtleFill,
  },
  inputDisabled: { opacity: 0.5 },
  recording: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[2],
    minHeight: touchTarget,
  },
  recordingDot: { width: 8, height: 8, borderRadius: radius.avatar, backgroundColor: colors.live },
})
