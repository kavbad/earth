'use client'

import { copy } from '@earth/ui'

import { PrivacySettings } from '../_components/PrivacySettings'
import { SettingsFrame } from '../_components/SettingsFrame'

/** `/you/settings/privacy` — SCREEN 25 privacy. */
export default function PrivacySettingsPage() {
  return (
    <SettingsFrame title={copy.settings.sections.privacy.title}>
      <PrivacySettings />
    </SettingsFrame>
  )
}
