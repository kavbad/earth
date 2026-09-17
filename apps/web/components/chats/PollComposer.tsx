'use client'

/**
 * Create a poll (SCREEN 10 plus sheet → Poll): a question and two to six options. The message
 * carries the question as text so previews and search work; votes are reactions.
 */
import { useState } from 'react'

import { Button } from '../ui/Button'
import { Icon } from '../ui/Icon'
import { Sheet } from '../ui/Sheet'
import { TextField } from '../ui/TextField'
import { chatCopy } from './copy'
import { POLL_OPTIONS_MAX, POLL_OPTIONS_MIN, POLL_TEXT_MAX } from './payloads'

export interface PollComposerProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onCreate: (question: string, options: readonly string[]) => void
}

export function validPollOptions(options: readonly string[]): string[] {
  return options.map((option) => option.trim()).filter((option) => option.length > 0)
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

  return (
    <Sheet
      open={open}
      onClose={() => {
        reset()
        onClose()
      }}
      title={chatCopy.createPoll}
      closeButton
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          if (!canCreate) return
          onCreate(question.trim(), valid)
          reset()
          onClose()
        }}
      >
        <TextField
          label={chatCopy.pollQuestion}
          value={question}
          maxLength={POLL_TEXT_MAX}
          onChange={(event) => setQuestion(event.target.value)}
          autoFocus
        />
        {options.map((option, index) => (
          <div key={index} className="flex items-end gap-2">
            <TextField
              className="flex-1"
              label={chatCopy.pollOption(index + 1)}
              value={option}
              maxLength={POLL_TEXT_MAX}
              onChange={(event) =>
                setOptions((current) =>
                  current.map((value, i) => (i === index ? event.target.value : value)),
                )
              }
            />
            {options.length > POLL_OPTIONS_MIN ? (
              <button
                type="button"
                aria-label={chatCopy.removeOption(index + 1)}
                onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}
                className="flex size-touch-target items-center justify-center rounded-avatar text-text-secondary hover:bg-subtle-fill"
              >
                <Icon name="close" size="small" />
              </button>
            ) : null}
          </div>
        ))}
        {options.length < POLL_OPTIONS_MAX ? (
          <Button variant="quiet" onClick={() => setOptions((current) => [...current, ''])}>
            {chatCopy.addOption}
          </Button>
        ) : null}
        <Button type="submit" variant="primary" fullWidth disabled={!canCreate}>
          {chatCopy.createPoll}
        </Button>
      </form>
    </Sheet>
  )
}
