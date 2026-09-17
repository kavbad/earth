/**
 * Whether the app is in the foreground (the mobile counterpart of `document.visibilityState`):
 * marks read only while the conversation is really on screen, refreshes subscriptions when the
 * app comes back, and gates presence pings. `isActive()` reads the latest value for callbacks
 * that must not re-subscribe on every change (never read during render).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'

function isActiveStatus(status: AppStateStatus): boolean {
  return status === 'active'
}

export interface AppForeground {
  readonly active: boolean
  /** Always current, for callbacks that must not re-subscribe on every change. */
  isActive(): boolean
}

export function useAppForeground(onForeground?: () => void): AppForeground {
  const [active, setActive] = useState(() => isActiveStatus(AppState.currentState))
  const activeRef = useRef(active)
  const callback = useRef(onForeground)
  useEffect(() => {
    callback.current = onForeground
  }, [onForeground])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      const next = isActiveStatus(status)
      const was = activeRef.current
      activeRef.current = next
      setActive(next)
      if (next && !was) callback.current?.()
    })
    return () => subscription.remove()
  }, [])

  const isActive = useCallback(() => activeRef.current, [])

  return { active, isActive }
}
