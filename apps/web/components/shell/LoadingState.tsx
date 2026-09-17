'use client'

import { copy } from '@earth/ui'
import type { ReactNode } from 'react'

import { useOnline } from '../../lib/providers/OfflineProvider'

/**
 * Spec §107: while the device cannot reach Earth, a screen with nothing to show says
 * "Waiting for connection" — never a skeleton that will not resolve, and never a generic error
 * that blames the content ("This conversation isn't available") for a missing network. Wrap the
 * first-load placeholder and the failure that replaces it; cached content is not affected,
 * because screens only reach this while they have nothing to show yet.
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
