import { copy } from '@earth/ui'

import { cx } from './cx'

export interface LiveMarkProps {
  /** Show the word next to the dot; the dot alone still carries the accessible name. */
  readonly text?: boolean
  readonly className?: string | undefined
}

/** Spec §92: a small red dot and the meta word "Live" — never a colored border. */
export function LiveMark({ text = true, className }: LiveMarkProps) {
  return (
    <span
      role="img"
      aria-label={copy.tabs.live}
      className={cx('inline-flex items-center gap-1 text-meta text-live', className)}
    >
      <span aria-hidden="true" className="size-2 rounded-avatar bg-live" />
      {text ? <span aria-hidden="true">{copy.tabs.live}</span> : null}
    </span>
  )
}
