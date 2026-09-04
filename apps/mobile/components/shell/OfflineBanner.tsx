import { copy } from '@earth/ui'

import { StatusLine } from '@/components/ui/StatusLine'
import { useOnline } from '@/lib/providers/OfflineProvider'

/** Spec §107: "Waiting for connection" — a quiet line, not an error. */
export function OfflineBanner() {
  const online = useOnline()
  if (online) return null
  return <StatusLine message={copy.waitingForConnection} banner />
}
