'use client'

import { copy } from '@earth/ui'

import { SafetySettings } from '../_components/SafetySettings'
import { SettingsFrame } from '../_components/SettingsFrame'

/** `/you/settings/safety` — SCREEN 25 safety. */
export default function SafetySettingsPage() {
  return (
    <SettingsFrame title={copy.settings.sections.safety.title}>
      <SafetySettings />
    </SettingsFrame>
  )
}
