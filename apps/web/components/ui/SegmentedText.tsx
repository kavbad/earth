'use client'

import { type KeyboardEvent, useRef } from 'react'

import { cx } from './cx'

export type SegmentState = 'available' | 'claim' | 'disabled'

/**
 * How the row behaves for assistive technology. `tabs` is the browsing control (the radius:
 * choosing one swaps the content of the screen); `radiogroup` is a single-choice form field
 * (share duration, precision, a default audience) where arrow keys also make the choice.
 */
export type SegmentRole = 'tabs' | 'radiogroup'

export interface SegmentOption<K extends string> {
  readonly key: K
  readonly label: string
  /** `claim` renders like available (the tap opens the claim sheet); `disabled` is inert. */
  readonly state?: SegmentState
}

export interface SegmentedTextProps<K extends string> {
  readonly label: string
  readonly options: ReadonlyArray<SegmentOption<K>>
  readonly value: K
  readonly onSelect: (key: K) => void
  readonly role?: SegmentRole
  readonly className?: string | undefined
}

/**
 * The text row control (spec §93): plain labels, no filled segmented background. Selected item is
 * primary text with a 2 px understated underline; the rest is secondary gray. Arrow keys move
 * along the row so it reads as one control.
 */
export function SegmentedText<K extends string>({
  label,
  options,
  value,
  onSelect,
  role = 'tabs',
  className,
}: SegmentedTextProps<K>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const radio = role === 'radiogroup'

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const enabled = options
      .map((option, i) => ({ option, i }))
      .filter(({ option }) => option.state !== 'disabled')
    if (enabled.length === 0) return
    const position = enabled.findIndex(({ i }) => i === index)
    let next: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      next = enabled[(position + 1) % enabled.length]?.i ?? null
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      next = enabled[(position - 1 + enabled.length) % enabled.length]?.i ?? null
    }
    if (event.key === 'Home') next = enabled[0]?.i ?? null
    if (event.key === 'End') next = enabled[enabled.length - 1]?.i ?? null
    if (next === null) return
    event.preventDefault()
    refs.current[next]?.focus()
    // A radio group commits on arrow; tabs only move focus and commit on Enter/Space.
    const option = options[next]
    if (radio && option !== undefined) onSelect(option.key)
  }

  return (
    <div
      role={radio ? 'radiogroup' : 'tablist'}
      aria-label={label}
      className={cx('flex items-end gap-5', className)}
    >
      {options.map((option, index) => {
        const selected = option.key === value
        const disabled = option.state === 'disabled'
        return (
          <button
            key={option.key}
            ref={(el) => {
              refs.current[index] = el
            }}
            type="button"
            role={radio ? 'radio' : 'tab'}
            {...(radio ? { 'aria-checked': selected } : { 'aria-selected': selected })}
            aria-disabled={disabled || undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              if (!disabled) onSelect(option.key)
            }}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cx(
              'relative min-h-touch-target bg-transparent px-0 pb-2 text-body transition-colors duration-fast ease-standard',
              selected ? 'font-medium text-text-primary' : 'text-text-secondary',
              disabled && 'opacity-40',
            )}
          >
            {option.label}
            <span
              aria-hidden="true"
              className={cx(
                'absolute inset-x-0 bottom-0 h-(--earth-border-indicator) rounded-avatar bg-text-primary transition-opacity duration-fast ease-standard',
                selected ? 'opacity-100' : 'opacity-0',
              )}
            />
          </button>
        )
      })}
    </div>
  )
}
