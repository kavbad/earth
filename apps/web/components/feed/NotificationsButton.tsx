/**
 * The Notifications control in Home's header (SCREEN 02 → 23): a 44px bell that links to
 * `/notifications`, with a small Earth-accent dot when something is unread — the accent appears
 * sparingly (spec §89). `@earth/ui` has no bell of its own, so the glyph is drawn here from the
 * shared icon conventions, as the mobile control does. Humans only.
 */
import {
  ICON_LINECAP,
  ICON_LINEJOIN,
  ICON_STROKE_WIDTH,
  ICON_VIEWBOX,
  copy,
  iconSize,
} from '@earth/ui'
import Link from 'next/link'

import { NOTIFICATIONS_ROUTE } from '../profile/routes'
import { feedCopy } from './copy'

const BELL_PATHS = [
  'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9',
  'M10.3 21a1.94 1.94 0 0 0 3.4 0',
] as const

/** "Notifications" — and what is waiting, so the dot is never the only word for it. */
export function notificationsButtonLabel(unreadCount: number): string {
  return unreadCount > 0
    ? `${copy.notificationsTitle}, ${feedCopy.unreadCount(unreadCount)}`
    : copy.notificationsTitle
}

export function NotificationsButton({ unreadCount }: { readonly unreadCount: number }) {
  return (
    <Link
      href={NOTIFICATIONS_ROUTE}
      aria-label={notificationsButtonLabel(unreadCount)}
      className="relative flex size-touch-target items-center justify-center rounded-avatar text-text-primary transition-colors duration-fast ease-standard hover:bg-subtle-fill"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={ICON_VIEWBOX}
        width={iconSize.base}
        height={iconSize.base}
        aria-hidden="true"
      >
        {BELL_PATHS.map((d) => (
          <path
            key={d}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={ICON_STROKE_WIDTH}
            strokeLinecap={ICON_LINECAP}
            strokeLinejoin={ICON_LINEJOIN}
          />
        ))}
      </svg>
      {unreadCount > 0 ? (
        <span
          aria-hidden="true"
          className="absolute top-2 right-2 size-2 rounded-avatar bg-earth-accent ring-2 ring-background"
        />
      ) : null}
    </Link>
  )
}
