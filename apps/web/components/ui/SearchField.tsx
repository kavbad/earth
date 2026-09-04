import type { InputHTMLAttributes } from 'react'

import { Icon } from './Icon'
import { cx } from './cx'

export interface SearchFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'className'
> {
  /** Visually hidden name of the field; the placeholder repeats it for sighted people. */
  readonly label: string
  readonly className?: string | undefined
}

/**
 * The one search input (SCREEN 08, 09, 21 and the place sheet): a subtle-fill row with the search
 * glyph inside it. One place so the leading inset stays on the 8 pt grid (16 + 16 + 8 = 40) and
 * the field keeps the 44 pt minimum hit target.
 */
export function SearchField({ label, className, ...rest }: SearchFieldProps) {
  return (
    <label className={cx('relative block', className)}>
      <span className="sr-only">{label}</span>
      <span className="pointer-events-none absolute inset-y-0 left-4 flex items-center text-text-secondary">
        <Icon name="search" size="small" />
      </span>
      <input
        type="search"
        autoComplete="off"
        className="min-h-touch-target w-full rounded-medium bg-subtle-fill py-2 pr-4 pl-10 text-body text-text-primary placeholder:text-text-secondary"
        {...rest}
      />
    </label>
  )
}
