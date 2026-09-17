'use client'

/**
 * "Here" (SCREEN 10 plus sheet): precise location sharing is bounded and lives on the Earth map
 * (spec §75 "Share with Weekend Crew", 1 hour / Tonight / Custom). This sheet names the
 * durations and hands off to the map — location-sharing writes never happen from a chat.
 */
import { copy } from '@earth/ui'
import Link from 'next/link'

import { Sheet } from '../ui/Sheet'
import { chatCopy } from './copy'
import { earthShareRoute } from './routes'

export interface HereSheetProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly conversationId: string
  readonly conversationTitle: string
}

export function HereSheet({ open, onClose, conversationId, conversationTitle }: HereSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={copy.shareWith(conversationTitle)} closeButton>
      <p className="text-body text-text-secondary">{chatCopy.hereBody}</p>
      <ul
        className="mt-3 flex gap-4 text-secondary text-text-secondary"
        aria-label={copy.composerActions.here}
      >
        <li>{copy.durations.oneHour}</li>
        <li>{copy.durations.tonight}</li>
        <li>{copy.durations.custom}</li>
      </ul>
      <Link
        href={earthShareRoute(conversationId)}
        onClick={onClose}
        className="mt-5 flex min-h-touch-target items-center justify-center rounded-medium bg-text-primary px-5 text-body font-medium text-background"
      >
        {chatCopy.shareOnEarth}
      </Link>
    </Sheet>
  )
}
