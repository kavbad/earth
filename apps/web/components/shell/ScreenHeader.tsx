import { APP_NAME } from '@earth/ui'
import type { ReactNode } from 'react'

import { cx } from '../ui/cx'
import { CONTENT_MAX_WIDTH_CLASS } from './PageContainer'

export interface ScreenHeaderProps {
  /** Without a title the header shows the `earth` wordmark (SCREEN 01/02). */
  readonly title?: string
  /** "North Beach", the current City — rendered only when given (SCREEN 03/04). */
  readonly subtitle?: string
  /** Back control or similar, at the leading edge. */
  readonly leading?: ReactNode
  readonly trailing?: ReactNode
  /** The radius control, presence row, search field — rendered under the title line. */
  readonly children?: ReactNode
  /** Presence row (SCREEN 02): pass only with meaningful state; nothing renders otherwise. */
  readonly presence?: ReactNode
  readonly className?: string | undefined
}

/** Sticky white header: wordmark or title, optional subtitle, then the radius / presence rows. */
export function ScreenHeader({
  title,
  subtitle,
  leading,
  trailing,
  children,
  presence,
  className,
}: ScreenHeaderProps) {
  return (
    <header
      className={cx(
        'sticky top-0 z-sticky bg-background pt-[env(safe-area-inset-top)] hairline-b',
        className,
      )}
    >
      <div
        className={cx(
          'mx-auto flex flex-col gap-2 px-screen-margin pt-3 pb-2',
          CONTENT_MAX_WIDTH_CLASS,
        )}
      >
        <div className="flex min-h-touch-target items-center gap-3">
          {leading !== undefined ? <div className="-ml-2 shrink-0">{leading}</div> : null}
          <div className="flex min-w-0 flex-1 flex-col">
            {title === undefined ? (
              <h1 className="text-title">{APP_NAME}</h1>
            ) : (
              <h1 className="truncate text-section">{title}</h1>
            )}
            {subtitle ? (
              <p className="truncate text-secondary text-text-secondary">{subtitle}</p>
            ) : null}
          </div>
          {trailing !== undefined ? <div className="-mr-2 shrink-0">{trailing}</div> : null}
        </div>
        {children}
        {presence !== undefined && presence !== null && presence !== false ? (
          <div className="text-secondary text-text-secondary">{presence}</div>
        ) : null}
      </div>
    </header>
  )
}
