import { type InputHTMLAttributes, type ReactNode, useId } from 'react'

import { cx } from './cx'

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly label: string
  readonly hint?: string
  readonly error?: string | null
  /** Small text rendered inline after the input (availability, counters). */
  readonly trailing?: ReactNode
  readonly id?: string
}

export const FIELD_INPUT_CLASS =
  'w-full min-h-touch-target rounded-medium bg-subtle-fill px-4 text-body text-text-primary placeholder:text-text-secondary disabled:opacity-50'

/** A labelled input: label always visible, hint and error wired through `aria-describedby`. */
export function TextField({
  label,
  hint,
  error,
  trailing,
  id,
  className,
  ...rest
}: TextFieldProps) {
  const generated = useId()
  const inputId = id ?? generated
  const hintId = `${inputId}-hint`
  const errorId = `${inputId}-error`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ')
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={inputId} className="text-secondary text-text-secondary">
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          className={cx(FIELD_INPUT_CLASS, trailing !== undefined && 'pr-24')}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy === '' ? undefined : describedBy}
          {...rest}
        />
        {trailing !== undefined ? (
          <span className="pointer-events-none absolute inset-y-0 right-4 flex items-center text-meta text-text-secondary">
            {trailing}
          </span>
        ) : null}
      </div>
      {hint ? (
        <p id={hintId} className="text-secondary text-text-secondary">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-secondary text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
