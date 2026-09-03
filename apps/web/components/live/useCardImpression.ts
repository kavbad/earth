'use client'

import { useCallback, useEffect, useRef } from 'react'

/** Half the card visible counts as seen (spec §97 `live_card_impression`), reported once. */
export const IMPRESSION_THRESHOLD = 0.5

/**
 * A ref callback that reports the first time the element is at least half on screen. Without
 * `IntersectionObserver` (old browsers, tests) nothing is reported — an impression is never
 * guessed.
 */
export function useCardImpression(onSeen: () => void): (element: HTMLElement | null) => void {
  const seen = useRef(false)
  const observer = useRef<IntersectionObserver | null>(null)
  const latest = useRef(onSeen)
  useEffect(() => {
    latest.current = onSeen
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
    if (element === null || seen.current || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        if (seen.current) return
        if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= IMPRESSION_THRESHOLD)) {
          seen.current = true
          io.disconnect()
          latest.current()
        }
      },
      { threshold: IMPRESSION_THRESHOLD },
    )
    io.observe(element)
    observer.current = io
  }, [])
}
