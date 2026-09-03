/**
 * Keeps approximate / precise shares fresh while the app is in front (spec §74–§75): one
 * `expo-location` watch, planned by the pure `watchPlan` from the active shares, sends each fix
 * with `location_share_update`. Stops on its own when the app leaves the foreground, when a share
 * is revoked or expires (the plan re-evaluates at the soonest expiry), when the permission is
 * gone, or when nothing needs a position (City shares never do). Never in the background.
 */
import { useEffect, useRef, useState } from 'react'
import { AppState, type AppStateStatus } from 'react-native'

import { type PositionWatch, watchPosition } from '../location'
import { useEarthShell } from '../shell'
import { SHARE_UPDATE_INTERVAL_MS, watchPlan } from '../state/location'
import type { MyShare } from '../state/myShares'
import type { LatLng } from '../state/view'

function isForeground(status: AppStateStatus): boolean {
  return status === 'active'
}

export function useShareUpdater(shares: readonly MyShare[], enabled: boolean): void {
  const { earth } = useEarthShell()
  const [foregrounded, setForegrounded] = useState(() => isForeground(AppState.currentState))
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      setForegrounded(isForeground(status))
      setNow(Date.now())
    })
    return () => subscription.remove()
  }, [])

  const plan = enabled ? watchPlan(shares, now, foregrounded) : null
  // The plan as a string so a re-created array with the same shares does not restart the watch.
  const signature =
    plan === null
      ? ''
      : `${plan.accuracy}:${plan.timeInterval}:${plan.distanceInterval}:${plan.shareIds.join(',')}`
  const until = plan?.until ?? null
  const shareIds = useRef<readonly string[]>([])
  const planShareIds = plan?.shareIds ?? null
  useEffect(() => {
    shareIds.current = planShareIds ?? []
  }, [planShareIds])

  useEffect(() => {
    if (plan === null || signature === '') return
    let cancelled = false
    let watch: PositionWatch | null = null
    let lastSentAt = 0
    const onFix = (position: LatLng) => {
      if (cancelled) return
      const at = Date.now()
      if (at - lastSentAt < SHARE_UPDATE_INTERVAL_MS) return
      lastSentAt = at
      for (const shareId of shareIds.current) {
        earth.location.updateShare({ shareId, position }).catch(() => {
          // A share that ended meanwhile answers with an error; the next plan drops it.
        })
      }
    }
    void watchPosition(plan, onFix).then((created) => {
      if (cancelled) {
        created?.remove()
        return
      }
      watch = created
    })
    return () => {
      cancelled = true
      watch?.remove()
      watch = null
    }
    // `signature` stands in for `plan`: same shares, same accuracy → the same watch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [earth, signature])

  // Re-evaluate when the soonest share ends so the watch stops without a revoke.
  useEffect(() => {
    if (until === null) return
    const delay = Math.max(0, until - Date.now()) + 1_000
    const timer = setTimeout(() => setNow(Date.now()), delay)
    return () => clearTimeout(timer)
  }, [until])
}
