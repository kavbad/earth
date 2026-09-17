/**
 * The push permission as Settings → Notifications shows it (spec §85): what the OS remembers,
 * re-read when the app returns to the foreground; "Allow notifications" asks (and marks the
 * interest the shell's registrar waits for), a refused ask offers the system Settings instead.
 */
import { useCallback, useEffect, useState } from 'react'
import { AppState } from 'react-native'

import { markPushInterest, readPushPermission, requestPushPermission } from '@/lib/push'

import { openSystemSettings } from '../location'
import { type PushPermissionState, pushPermissionAction } from '../state/prefs'

export interface PushPermissionController {
  readonly state: PushPermissionState
  readonly action: ReturnType<typeof pushPermissionAction>
  readonly busy: boolean
  ask(): Promise<void>
  openSettings(): Promise<void>
}

export function usePushPermission(): PushPermissionController {
  const [state, setState] = useState<PushPermissionState>('unknown')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    const refresh = () => {
      void readPushPermission().then((permission) => {
        if (!active) return
        setState((current) =>
          // A refused ask stays "blocked" (offer Settings) until the OS says granted.
          current === 'blocked' && permission === 'denied' ? current : permission,
        )
      })
    }
    refresh()
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') refresh()
    })
    return () => {
      active = false
      subscription.remove()
    }
  }, [])

  const ask = useCallback(async () => {
    setBusy(true)
    try {
      const permission = await requestPushPermission()
      if (permission === 'granted') markPushInterest('notifications')
      setState(permission === 'denied' ? 'blocked' : permission)
    } finally {
      setBusy(false)
    }
  }, [])

  const openSettings = useCallback(async () => {
    await openSystemSettings()
  }, [])

  return { state, action: pushPermissionAction(state), busy, ask, openSettings }
}
