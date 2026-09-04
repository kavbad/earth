'use client'

import { copy } from '@earth/ui'

import { useOnline } from '../../lib/providers/OfflineProvider'

/** Spec §107: "Waiting for connection" — a quiet line, not an error. */
export function OfflineBanner() {
  const online = useOnline()
  if (online) return null
  return (
    <div
      role="status"
      className="fade-in bg-subtle-fill px-screen-margin py-2 text-center text-secondary text-text-secondary"
    >
      {copy.waitingForConnection}
    </div>
  )
}
