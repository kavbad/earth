'use client'

/**
 * A light pull-to-refresh for touch browsers: a downward drag from the top of the page past
 * `PULL_THRESHOLD_PX` triggers `onRefresh`. Desktop keeps the refresh on window focus and the
 * inline control; nothing here fights the browser's own overscroll.
 */
import { type TouchEvent, useCallback, useRef, useState } from 'react'

export const PULL_THRESHOLD_PX = 64
/** Visual travel is damped so the row moves less than the finger. */
export const PULL_DAMPING = 0.5

export interface PullToRefreshBinding {
  readonly onTouchStart: (event: TouchEvent<HTMLElement>) => void
  readonly onTouchMove: (event: TouchEvent<HTMLElement>) => void
  readonly onTouchEnd: () => void
}

export interface PullToRefresh {
  readonly bind: PullToRefreshBinding
  /** Damped pull distance in px (0 when idle). */
  readonly offset: number
  readonly armed: boolean
}

function atTop(): boolean {
  return typeof window === 'undefined' || window.scrollY <= 0
}

export function usePullToRefresh(onRefresh: () => void, enabled = true): PullToRefresh {
  const startY = useRef<number | null>(null)
  const [offset, setOffset] = useState(0)

  const onTouchStart = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      if (!enabled || !atTop()) return
      startY.current = event.touches[0]?.clientY ?? null
    },
    [enabled],
  )

  const onTouchMove = useCallback((event: TouchEvent<HTMLElement>) => {
    if (startY.current === null) return
    const y = event.touches[0]?.clientY
    if (y === undefined) return
    const distance = (y - startY.current) * PULL_DAMPING
    if (distance <= 0 || !atTop()) {
      startY.current = null
      setOffset(0)
      return
    }
    setOffset(Math.min(distance, PULL_THRESHOLD_PX * 1.5))
  }, [])

  const onTouchEnd = useCallback(() => {
    const armed = offset >= PULL_THRESHOLD_PX
    startY.current = null
    setOffset(0)
    if (armed) onRefresh()
  }, [offset, onRefresh])

  return {
    bind: { onTouchStart, onTouchMove, onTouchEnd },
    offset,
    armed: offset >= PULL_THRESHOLD_PX,
  }
}
