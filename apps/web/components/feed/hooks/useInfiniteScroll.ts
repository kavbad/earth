'use client'

import { useCallback, useEffect, useRef } from 'react'

/** The sentinel asks for the next page this far before it reaches the viewport. */
export const INFINITE_SCROLL_MARGIN = '600px'

/**
 * A ref callback for a sentinel element at the end of a list: when it comes near the viewport,
 * `onNearEnd` fires (once per approach). Without `IntersectionObserver` nothing loads
 * automatically; the list's explicit control still works.
 */
export function useInfiniteScroll(onNearEnd: () => void): (element: HTMLElement | null) => void {
  const observer = useRef<IntersectionObserver | null>(null)
  const latest = useRef(onNearEnd)
  useEffect(() => {
    latest.current = onNearEnd
  })
  useEffect(
    () => () => {
      observer.current?.disconnect()
      observer.current = null
    },
    [],
  )
  return useCallback((element: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (element === null || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) latest.current()
      },
      { rootMargin: INFINITE_SCROLL_MARGIN },
    )
    io.observe(element)
    observer.current = io
  }, [])
}
