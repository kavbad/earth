/**
 * SCREEN 02 → 23: Home's Notifications control. The screen has no tab of its own, so this header
 * link is the only way into it — it must carry the destination and say what is waiting, in words
 * as well as the dot.
 *
 * `next/link` resolves its own copy of React here (the workspace hoists three), which the
 * renderer cannot drive; the link is stood in for by the `<a>` it renders in the browser.
 */
import { copy } from '@earth/ui'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { NOTIFICATIONS_ROUTE } from '../profile/routes'
import { NotificationsButton, notificationsButtonLabel } from './NotificationsButton'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

describe('NotificationsButton', () => {
  it('links to SCREEN 23 with an accessible name', () => {
    const html = renderToStaticMarkup(<NotificationsButton unreadCount={0} />)
    expect(html).toContain(`href="${NOTIFICATIONS_ROUTE}"`)
    expect(html).toContain(`aria-label="${copy.notificationsTitle}"`)
  })

  it('shows the unread dot only when something is unread, and names the count', () => {
    const quiet = renderToStaticMarkup(<NotificationsButton unreadCount={0} />)
    expect(quiet).not.toContain('bg-earth-accent')
    const waiting = renderToStaticMarkup(<NotificationsButton unreadCount={3} />)
    expect(waiting).toContain('bg-earth-accent')
    expect(waiting).toContain('aria-label="Notifications, 3 unread"')
  })

  it('says the count in words, singular and plural', () => {
    expect(notificationsButtonLabel(0)).toBe(copy.notificationsTitle)
    expect(notificationsButtonLabel(1)).toBe(`${copy.notificationsTitle}, 1 unread`)
    expect(notificationsButtonLabel(4)).toBe(`${copy.notificationsTitle}, 4 unread`)
  })
})
