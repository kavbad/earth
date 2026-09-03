import type { ReactNode } from 'react'

import { cx } from '../ui/cx'

export interface PageContainerProps {
  readonly children: ReactNode
  /** Map and media surfaces run edge to edge; feeds and chats read best at 680px. */
  readonly fullBleed?: boolean
  readonly className?: string | undefined
}

export const CONTENT_MAX_WIDTH_CLASS = 'max-w-[680px]' as const

export function PageContainer({ children, fullBleed = false, className }: PageContainerProps) {
  return (
    <div className={cx('w-full', !fullBleed && `mx-auto ${CONTENT_MAX_WIDTH_CLASS}`, className)}>
      {children}
    </div>
  )
}
