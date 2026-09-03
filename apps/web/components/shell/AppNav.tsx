'use client'

import { APP_NAME, TABS, TAB_ICONS, type Tab, copy } from '@earth/ui'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { webCopy } from '../../lib/copy'
import { ROUTES, TAB_ROUTES, tabForPathname } from '../../lib/routes'
import { Icon } from '../ui/Icon'
import { cx } from '../ui/cx'

function TabLink({ tab, active, rail }: { tab: Tab; active: boolean; rail: boolean }) {
  return (
    <Link
      href={TAB_ROUTES[tab]}
      aria-current={active ? 'page' : undefined}
      aria-label={copy.tabs[tab]}
      className={cx(
        'flex items-center justify-center gap-3 transition-colors duration-fast ease-standard',
        rail
          ? 'h-touch-target w-full justify-start rounded-medium px-3 hover:bg-subtle-fill'
          : 'h-full flex-1 flex-col gap-0.5',
        active ? 'text-text-primary' : 'text-text-secondary',
      )}
    >
      <Icon name={TAB_ICONS[tab]} className={cx(tab === 'live' && active && 'text-live')} />
      <span className={cx(rail ? 'text-body' : 'text-meta')}>{copy.tabs[tab]}</span>
    </Link>
  )
}

/** Spec §50: Home · Chats · Live · Earth · You. Live sits in the centre as a destination, not a create button. */
export function BottomNav() {
  const pathname = usePathname()
  const current = tabForPathname(pathname)
  return (
    <nav
      aria-label={webCopy.mainNavigation}
      className="fixed inset-x-0 bottom-0 z-sticky bg-background pb-[env(safe-area-inset-bottom)] hairline-t rail:hidden"
    >
      <div className="mx-auto flex h-16 max-w-[680px]">
        {TABS.map((tab) => (
          <TabLink key={tab} tab={tab} active={current === tab} rail={false} />
        ))}
      </div>
    </nav>
  )
}

/** The same five destinations as a slim left rail from 900px up. */
export function LeftRail() {
  const pathname = usePathname()
  const current = tabForPathname(pathname)
  return (
    <nav
      aria-label={webCopy.mainNavigation}
      className="sticky top-0 hidden h-dvh w-[200px] shrink-0 flex-col gap-1 px-3 pt-4 rail:flex"
    >
      <Link href={ROUTES.home} className="mb-4 px-3 text-title tracking-tight">
        {APP_NAME}
      </Link>
      {TABS.map((tab) => (
        <TabLink key={tab} tab={tab} active={current === tab} rail />
      ))}
    </nav>
  )
}
