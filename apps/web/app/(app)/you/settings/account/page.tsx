'use client'

import { copy } from '@earth/ui'

import { AccountSettings } from '../_components/AccountSettings'
import { SettingsFrame } from '../_components/SettingsFrame'

/** `/you/settings/account` — SCREEN 25 Account. */
export default function AccountSettingsPage() {
  return (
    <SettingsFrame title={copy.settings.sections.account.title}>
      <AccountSettings />
    </SettingsFrame>
  )
}
