'use client'

import { copy } from '@earth/ui'

import { IdentitySettings } from '../_components/IdentitySettings'
import { SettingsFrame } from '../_components/SettingsFrame'

/** `/you/settings/identity` — SCREEN 25 humanIdentity. */
export default function IdentitySettingsPage() {
  return (
    <SettingsFrame title={copy.settings.sections.humanIdentity.title}>
      <IdentitySettings />
    </SettingsFrame>
  )
}
