/**
 * The Search control in Home's header (SCREEN 02 → 21): a 44px link to `/search`, and the
 * persistent way into universal search — People, Groups, Places, Posts. It sits beside
 * Notifications for everyone, Visitors included (they search people and places), matching the
 * mobile client's header control.
 */
import Link from 'next/link'

import { searchRoute } from '../profile/routes'
import { Icon } from '../ui/Icon'
import { feedCopy } from './copy'

export function SearchButton() {
  return (
    <Link
      href={searchRoute()}
      aria-label={feedCopy.openSearch}
      className="flex size-touch-target items-center justify-center rounded-avatar text-text-primary transition-colors duration-fast ease-standard hover:bg-subtle-fill"
    >
      <Icon name="search" />
    </Link>
  )
}
