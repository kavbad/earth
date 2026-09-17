import type { RoomVisibility } from '@earth/domain'
import { copy } from '@earth/ui'
import type { ReactNode } from 'react'

import { LiveMark } from '../ui/LiveMark'
import { roomCopy } from './copy'

export interface RoomHeaderProps {
  /** "Weekend Crew" or "Xavier + Kavon" (SCREEN 14 top). */
  readonly title: string
  readonly visibility: RoomVisibility
  readonly pendingVisibility: RoomVisibility | null
  readonly watchingCount: number
  readonly trailing?: ReactNode
}

/** Minimal chrome: the context, then one meta line — Live dot · audience · viewers. */
export function RoomHeader({
  title,
  visibility,
  pendingVisibility,
  watchingCount,
  trailing,
}: RoomHeaderProps) {
  const audience =
    pendingVisibility === null
      ? copy.visibility[visibility]
      : `${copy.visibility[visibility]} → ${copy.visibility[pendingVisibility]}`
  return (
    <header className="flex items-center gap-3 px-screen-margin pt-[calc(var(--earth-space-2)+env(safe-area-inset-top))] pb-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="truncate text-section">{title}</h1>
        <p className="flex items-center gap-2 text-meta text-text-secondary">
          <LiveMark />
          <span aria-hidden="true">·</span>
          <span>{audience}</span>
          {watchingCount > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{roomCopy.watching(watchingCount)}</span>
            </>
          ) : null}
        </p>
      </div>
      {trailing !== undefined ? <div className="-mr-2 shrink-0">{trailing}</div> : null}
    </header>
  )
}
