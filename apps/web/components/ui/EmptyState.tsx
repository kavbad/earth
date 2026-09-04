import type { ReactNode } from 'react'

import { cx } from './cx'

export interface EmptyStateProps {
  readonly title: string
  readonly body?: string
  readonly action?: ReactNode
  readonly className?: string | undefined
}

/** Only where an empty screen has something true to say (spec SCREEN 01–02: no placeholders). */
export function EmptyState({ title, body, action, className }: EmptyStateProps) {
  return (
    <div className={cx('flex flex-col items-start gap-2 px-screen-margin py-8', className)}>
      <p className="text-section">{title}</p>
      {body ? <p className="text-secondary text-text-secondary">{body}</p> : null}
      {action !== undefined ? <div className="mt-2">{action}</div> : null}
    </div>
  )
}
