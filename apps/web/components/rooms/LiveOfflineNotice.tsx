'use client'

import { copy } from '@earth/ui'

import { useOnline } from '../../lib/providers/OfflineProvider'

/**
 * Spec §107 on the Live surfaces that live outside the member shell (the room, the Guest page):
 * "Connection unavailable" while the device cannot reach Earth — one quiet line, no error page.
 */
export function LiveOfflineNotice() {
  const online = useOnline()
  if (online) return null
  return (
    <p
      role="status"
      className="fade-in bg-subtle-fill px-screen-margin py-2 text-center text-secondary text-text-secondary"
    >
      {copy.connectionUnavailable}
    </p>
  )
}
