'use client'

/**
 * Keeps active approximate/precise shares fresh while the Earth map is open: every interval the
 * device position is read once and sent with `location_share_update` for each such share. Stops
 * when the tab is hidden, when nothing needs updating, or when the page unmounts.
 */
import { useEffect } from 'react'

import { useEarth } from '../../lib/providers/RuntimeProvider'
import { browserGeolocation, requestPosition } from './geolocation'
import { type MyShare, sharesNeedingUpdates } from './state/myShares'

export const SHARE_UPDATE_INTERVAL_MS = 60_000

export function useShareUpdater(shares: readonly MyShare[], enabled: boolean): void {
  const earth = useEarth()
  const ids = shares.map((share) => share.id).join(',')

  useEffect(() => {
    if (!enabled || ids === '') return
    let cancelled = false
    const tick = async () => {
      if (cancelled || (typeof document !== 'undefined' && document.visibilityState === 'hidden'))
        return
      const due = sharesNeedingUpdates(shares, Date.now())
      if (due.length === 0) return
      const position = await requestPosition(browserGeolocation(), {
        highAccuracy: due.some((share) => share.precision === 'precise'),
      })
      if (!position.ok || cancelled) return
      await Promise.all(
        due.map((share) =>
          earth.location
            .updateShare({ shareId: share.id, position: position.position })
            .catch(() => undefined),
        ),
      )
    }
    const interval = setInterval(() => void tick(), SHARE_UPDATE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
    // `ids` stands in for `shares` so a re-created array with the same shares does not restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [earth, enabled, ids])
}
