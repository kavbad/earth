import { type TextareaHTMLAttributes, useId } from 'react'

import { FIELD_INPUT_CLASS } from './TextField'
import { cx } from './cx'

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  readonly label: string
  readonly hint?: string
  readonly error?: string | null
  readonly id?: string
}

export function TextArea({ label, hint, error, id, className, rows = 3, ...rest }: TextAreaProps) {
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
      <textarea
        id={inputId}
        rows={rows}
        className={cx(FIELD_INPUT_CLASS, 'resize-none py-3')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        {...rest}
      />
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
