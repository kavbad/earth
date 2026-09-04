import { webCopy } from '../../lib/copy'
import { cx } from './cx'

export interface SpinnerProps {
  readonly label?: string
  readonly className?: string | undefined
}

/** A quiet ring; announced as a status so screen readers know something is in progress. */
export function Spinner({ label = webCopy.loading, className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cx(
        'inline-block size-5 animate-spin rounded-avatar border-2 border-(color:--earth-color-separator) border-t-(color:--earth-color-text-primary)',
        className,
      )}
    />
  )
}
