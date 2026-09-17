import type { ReactNode } from 'react'

import { cx } from '../ui/cx'

export interface PageContainerProps {
  readonly children: ReactNode
  /** Map and media surfaces run edge to edge; feeds and chats read best at 680px. */
  readonly fullBleed?: boolean
  readonly className?: string | undefined
}

/**
 * The reading column feeds, chats and headers share: centred on a phone, and beside the rail —
 * with a breathing right margin — once the rail is there. Full-bleed surfaces (the map) opt out.
 */
export const CONTENT_COLUMN_CLASS = 'mx-auto max-w-content rail:mx-0 rail:ml-12' as const

export function PageContainer({ children, fullBleed = false, className }: PageContainerProps) {
  return (
    <div className={cx('w-full', !fullBleed && CONTENT_COLUMN_CLASS, className)}>{children}</div>
  )
}
