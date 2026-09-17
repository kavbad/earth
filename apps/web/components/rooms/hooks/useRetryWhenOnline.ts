'use client'

/**
 * Spec §109 "attempt automatic reconnect": when the network comes back after the reconnect
 * policy was exhausted for lack of it, the room tries again on its own; the person only has to
 * tap "Try again" after a failure the network did not cause.
 */
import { useEffect } from 'react'

import { useOnline } from '../../../lib/providers/OfflineProvider'
import { shouldRetryWhenOnline } from '../state/connection'
import type { MediaConnection } from './useMediaConnection'

export function useRetryWhenOnline(
  media: Pick<MediaConnection, 'status' | 'detail' | 'retry'>,
): void {
  const online = useOnline()
  const { status, detail, retry } = media
  const code = detail.code
  useEffect(() => {
    if (online && shouldRetryWhenOnline(status, { ...(code === undefined ? {} : { code }) })) {
      void retry()
    }
  }, [online, status, code, retry])
}
