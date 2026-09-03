'use client'

/**
 * The composer (SCREEN 10): `+ Message… microphone camera`. Twelve icons never show; the plus
 * opens a sheet. Typing swaps the microphone for send. Enter sends on keyboards, inserts a line
 * on touch. Voice recording takes the row over with elapsed time, cancel and stop-and-send.
 */
import { copy } from '@earth/ui'
import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { Icon } from '../ui/Icon'
import { Spinner } from '../ui/Spinner'
import { cx } from '../ui/cx'
import { chatCopy } from './copy'
import { formatDuration } from './payloads'
import type { ChatMessage } from './state/messages'

export const COMPOSER_MAX_ROWS = 5

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
  /** Voice recording state from `useVoiceRecorder`. */
  readonly recording: {
    readonly active: boolean
    readonly elapsedMs: number
    readonly supported: boolean
    readonly start: () => void
    readonly stop: () => void
    readonly cancel: () => void
  }
  /** A media upload in flight (the line above the row). */
  readonly uploading: boolean
}

function coarsePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
}

const subscribeNever = (): (() => void) => () => undefined

const ICON_BUTTON =
  'flex size-touch-target shrink-0 items-center justify-center rounded-avatar text-text-primary transition-colors duration-fast ease-standard hover:bg-subtle-fill disabled:opacity-40'

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
}: ComposerProps) {
  const [text, setText] = useState('')
  const textarea = useRef<HTMLTextAreaElement>(null)
  // Server snapshot: keyboards (the shell is mobile-first, but hydration must match the markup).
  const touch = useSyncExternalStore(subscribeNever, coarsePointer, () => false)

  useLayoutEffect(() => {
    const node = textarea.current
    if (node === null) return
    node.style.height = 'auto'
    const lineHeight = 24
    node.style.height = `${Math.min(node.scrollHeight, lineHeight * COMPOSER_MAX_ROWS + 16)}px`
  }, [text])

  useEffect(() => {
    if (replyTo !== null) textarea.current?.focus()
  }, [replyTo])

  const submit = () => {
    const trimmed = text.trim()
    if (trimmed.length === 0 || disabled) return
    onSendText(trimmed)
    setText('')
    textarea.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !touch && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value)
    if (event.target.value.trim().length > 0) onTyping()
  }

  const hasText = text.trim().length > 0

  return (
    <div className="sticky bottom-0 z-sticky bg-background pb-[env(safe-area-inset-bottom)] hairline-t">
      {uploading ? (
        <div
          role="status"
          className="flex items-center gap-2 px-screen-margin pt-2 text-meta text-text-secondary"
        >
          <Spinner label={chatCopy.uploading} className="size-3.5" />
          <span>{chatCopy.uploading}</span>
        </div>
      ) : null}
      {replyTo !== null ? (
        <div className="flex items-center gap-2 px-screen-margin pt-2 text-secondary text-text-secondary">
          <span className="min-w-0 flex-1 truncate">{chatCopy.replyTo(replyToName)}</span>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label={chatCopy.cancelReply}
            className="flex size-8 items-center justify-center rounded-avatar hover:bg-subtle-fill"
          >
            <Icon name="close" size="small" />
          </button>
        </div>
      ) : null}
      {recording.active ? (
        <div className="flex items-center gap-2 px-2 py-2">
          <button
            type="button"
            onClick={recording.cancel}
            aria-label={chatCopy.cancelRecording}
            className={ICON_BUTTON}
          >
            <Icon name="close" />
          </button>
          <span
            role="status"
            className="flex flex-1 items-center gap-2 px-2 text-body text-text-primary"
          >
            <span aria-hidden="true" className="size-2 rounded-avatar bg-live" />
            {chatCopy.recording} {formatDuration(recording.elapsedMs)}
          </span>
          <button
            type="button"
            onClick={recording.stop}
            aria-label={chatCopy.stopRecording}
            className={cx(ICON_BUTTON, 'bg-text-primary text-background hover:bg-text-primary')}
          >
            <Icon name="send" />
          </button>
        </div>
      ) : (
        <div className="flex items-end gap-1 px-2 py-2">
          <button
            type="button"
            onClick={onPlus}
            disabled={disabled}
            aria-label={chatCopy.attach}
            className={ICON_BUTTON}
          >
            <Icon name="plus" />
          </button>
          <label className="flex min-w-0 flex-1 items-center">
            <span className="sr-only">{copy.messagePlaceholder}</span>
            <textarea
              ref={textarea}
              rows={1}
              value={text}
              onChange={onChange}
              onKeyDown={onKeyDown}
              disabled={disabled}
              placeholder={copy.messagePlaceholder}
              enterKeyHint={touch ? 'enter' : 'send'}
              className="max-h-[136px] min-h-10 w-full resize-none rounded-medium bg-subtle-fill px-4 py-2 text-body text-text-primary placeholder:text-text-secondary disabled:opacity-50"
            />
          </label>
          {hasText ? (
            <button
              type="button"
              onClick={submit}
              disabled={disabled}
              aria-label={chatCopy.send}
              className={cx(ICON_BUTTON, 'bg-text-primary text-background hover:bg-text-primary')}
            >
              <Icon name="send" />
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={recording.start}
                disabled={disabled || !recording.supported}
                aria-label={chatCopy.voiceMessage}
                className={ICON_BUTTON}
              >
                <Icon name="mic" />
              </button>
              <button
                type="button"
                onClick={onCamera}
                disabled={disabled || cameraBusy}
                aria-label={cameraLabel}
                aria-busy={cameraBusy || undefined}
                className={ICON_BUTTON}
              >
                <Icon name="camera" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
