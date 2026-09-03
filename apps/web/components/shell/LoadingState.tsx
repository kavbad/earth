'use client'

import { copy } from '@earth/ui'
import type { ReactNode } from 'react'

import { useOnline } from '../../lib/providers/OfflineProvider'

/**
 * Spec §107: a first load that cannot start because the device is offline says
 * "Waiting for connection" instead of a skeleton that never resolves. Cached content is not
 * affected — screens only reach this while they have nothing to show yet.
 */
export function LoadingState({ children }: { readonly children: ReactNode }) {
  const online = useOnline()
  if (online) return <>{children}</>
  return (
    <p role="status" className="fade-in px-screen-margin py-6 text-secondary text-text-secondary">
      {copy.waitingForConnection}
    </p>
  )
}
