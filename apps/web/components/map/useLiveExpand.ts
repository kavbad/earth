'use client'

/**
 * The signature motion of spec §95: a map point expands into the Live. A white surface grows
 * from the marker to the viewport in 240 ms (scale + crossfade) and the room route takes over.
 * People who asked for reduced motion go straight to the room.
 */
import { motion } from '@earth/ui'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef } from 'react'

import { roomRoute } from '../rooms/routes'
import type { MarkerTap } from './types'

export const EXPAND_DURATION_MS = motion.duration.base

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Keeps the overlay while the next route paints; cleared on unmount. */
const OVERLAY_LINGER_MS = motion.duration.slow

export function useLiveExpand(): (roomId: string, rect: MarkerTap['rect']) => void {
  const router = useRouter()
  const overlay = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    return () => {
      overlay.current?.remove()
      overlay.current = null
    }
  }, [])

  return useCallback(
    (roomId, rect) => {
      const route = roomRoute(roomId)
      if (
        typeof document === 'undefined' ||
        prefersReducedMotion() ||
        typeof Element.prototype.animate !== 'function'
      ) {
        router.push(route)
        return
      }
      const element = document.createElement('div')
      element.setAttribute('aria-hidden', 'true')
      element.className = 'pointer-events-none fixed z-modal rounded-medium bg-background'
      element.style.left = `${rect.x}px`
      element.style.top = `${rect.y}px`
      element.style.width = `${Math.max(rect.width, 1)}px`
      element.style.height = `${Math.max(rect.height, 1)}px`
      element.style.transformOrigin = 'center'
      document.body.append(element)
      overlay.current?.remove()
      overlay.current = element
      const scaleX = window.innerWidth / Math.max(rect.width, 1)
      const scaleY = window.innerHeight / Math.max(rect.height, 1)
      const translateX = window.innerWidth / 2 - (rect.x + rect.width / 2)
      const translateY = window.innerHeight / 2 - (rect.y + rect.height / 2)
      const animation = element.animate(
        [
          { transform: 'translate(0, 0) scale(1, 1)', opacity: 0.4 },
          {
            transform: `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`,
            opacity: 1,
          },
        ],
        { duration: EXPAND_DURATION_MS, easing: motion.easing.standard, fill: 'forwards' },
      )
      animation.onfinish = () => {
        router.push(route)
        setTimeout(() => {
          if (overlay.current === element) {
            element.remove()
            overlay.current = null
          }
        }, OVERLAY_LINGER_MS)
      }
    },
    [router],
  )
}
