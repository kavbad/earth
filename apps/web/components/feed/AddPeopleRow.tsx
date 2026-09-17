'use client'

/**
 * SCREEN 02 zero-friends member state: "Add people you actually know" as a contextual row that
 * leads to search — never an onboarding takeover.
 */
import { copy } from '@earth/ui'
import Link from 'next/link'

import { searchRoute } from '../profile/routes'
import { Icon } from '../ui/Icon'
import { feedCopy } from './copy'

export function AddPeopleRow() {
  return (
    <Link
      href={searchRoute()}
      className="flex min-h-touch-target items-center gap-3 px-screen-margin py-3 transition-colors duration-fast ease-standard hover:bg-subtle-fill"
    >
      <span className="flex size-10 shrink-0 items-center justify-center rounded-avatar bg-subtle-fill text-text-secondary">
        <Icon name="search" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-body text-text-primary">{copy.addPeopleYouKnow}</span>
        <span className="text-secondary text-text-secondary">{feedCopy.addPeopleBody}</span>
      </span>
      <Icon name="chevron" size="small" className="shrink-0 text-text-secondary" />
    </Link>
  )
}
