'use client'

import { useSyncExternalStore } from 'react'

import { isMobileUserAgent } from './userAgent'

const subscribeNever = (): (() => void) => () => undefined

/** `false` during server rendering and hydration; the real answer after mount. */
export function useIsMobileUa(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => isMobileUserAgent(navigator.userAgent),
    () => false,
  )
}
