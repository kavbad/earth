'use client'

import { copy } from '@earth/ui'

import { NotificationSettings } from '../_components/NotificationSettings'
import { SettingsFrame } from '../_components/SettingsFrame'

/** `/you/settings/notifications` — SCREEN 25 notifications. */
export default function NotificationSettingsPage() {
  return (
    <SettingsFrame title={copy.settings.sections.notifications.title}>
      <NotificationSettings />
    </SettingsFrame>
  )
}
