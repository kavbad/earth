import { copy } from '@earth/ui'
import type { Metadata } from 'next'

import { NotificationsList } from '../../../components/feed/notifications/NotificationsList'

export const metadata: Metadata = { title: copy.notificationsTitle }

/** SCREEN 23 — Notifications. */
export default function NotificationsPage() {
  return <NotificationsList />
}
