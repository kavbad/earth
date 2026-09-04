/**
 * Create a poll (SCREEN 10 plus sheet → Poll): a question and two to six options. The message
 * carries the question as text so previews and search work; votes are reactions.
 */
import { colors, space } from '@earth/ui'
import { useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'

import { chatCopy } from '@/features/chats/copy'
import {
  POLL_OPTIONS_MAX,
  POLL_OPTIONS_MIN,
  POLL_TEXT_MAX,
  validPollOptions,
} from '@/features/chats/payloads'

import { Button, IconButton, Sheet, TextField } from '@/components/ui'

export interface PollComposerProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onCreate: (question: string, options: readonly string[]) => void
}

export function PollComposer({ open, onClose, onCreate }: PollComposerProps) {
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState<string[]>(['', ''])
  const valid = validPollOptions(options)
  const canCreate = question.trim().length > 0 && valid.length >= POLL_OPTIONS_MIN

  const reset = () => {
    setQuestion('')
    setOptions(['', ''])
  }
  const close = () => {
    reset()
    onClose()
  }
  const create = () => {
    if (!canCreate) return
    onCreate(question.trim(), valid)
    close()
  }

  return (
    <Sheet open={open} onClose={close} title={chatCopy.createPoll} closeButton avoidKeyboard>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
        <TextField
          label={chatCopy.pollQuestion}
          value={question}
          onChangeText={setQuestion}
          maxLength={POLL_TEXT_MAX}
          autoFocus
          returnKeyType="next"
        />
        {options.map((option, index) => (
          <View key={index} style={styles.optionRow}>
            <View style={styles.optionField}>
              <TextField
                label={chatCopy.pollOption(index + 1)}
                value={option}
                onChangeText={(value) =>
                  setOptions((current) => current.map((item, i) => (i === index ? value : item)))
                }
                maxLength={POLL_TEXT_MAX}
                returnKeyType={index === options.length - 1 ? 'done' : 'next'}
              />
            </View>
            {options.length > POLL_OPTIONS_MIN ? (
              <IconButton
                name="close"
                label={chatCopy.removeOption(index + 1)}
                onPress={() => setOptions((current) => current.filter((_, i) => i !== index))}
                color={colors.textSecondary}
              />
            ) : null}
          </View>
        ))}
        {options.length < POLL_OPTIONS_MAX ? (
          <Button
            label={chatCopy.addOption}
            variant="quiet"
            onPress={() => setOptions((current) => [...current, ''])}
          />
        ) : null}
        <Button label={chatCopy.createPoll} fullWidth disabled={!canCreate} onPress={create} />
      </ScrollView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  form: { gap: space[3] },
  optionRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space[2] },
  optionField: { flex: 1 },
})
