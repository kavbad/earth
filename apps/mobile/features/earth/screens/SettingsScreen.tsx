/**
 * `/you/settings` — SCREEN 25 index: Account, Privacy, Notifications, Safety, Human identity,
 * then sign out (confirmed in a sheet, never a system alert).
 */
import { colors, copy, space } from '@earth/ui'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { ListRow } from '@/components/ui/ListRow'
import { Sheet } from '@/components/ui/Sheet'

import { earthCopy, youCopy } from '../copy'
import { HOME_ROUTE, YOU_ROUTES } from '../routes'
import { useEarthShell } from '../shell'
import { SettingsBody, SettingsFrame, useSettingsBack } from './SettingsFrame'

const SECTIONS = [
  { key: 'account', route: YOU_ROUTES.account },
  { key: 'privacy', route: YOU_ROUTES.privacy },
  { key: 'notifications', route: YOU_ROUTES.notifications },
  { key: 'safety', route: YOU_ROUTES.safety },
  { key: 'humanIdentity', route: YOU_ROUTES.identity },
] as const

export function SettingsScreen() {
  const shell = useEarthShell()
  const router = useRouter()
  const back = useSettingsBack(YOU_ROUTES.you)
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const [busy, setBusy] = useState(false)

  const signOut = async () => {
    setBusy(true)
    try {
      await shell.signOut()
      setConfirmingSignOut(false)
      router.replace(HOME_ROUTE)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsFrame title={copy.settings.title} onBack={back}>
      <View style={styles.list}>
        {SECTIONS.map((section) => {
          const meta = copy.settings.sections[section.key]
          return (
            <ListRow
              key={section.key}
              title={meta.title}
              subtitle={Object.values(meta.items).join(' · ')}
              trailing={<Icon name="chevron" size="small" color={colors.textSecondary} />}
              onPress={() => router.push(section.route)}
            />
          )
        })}
      </View>
      <View style={styles.signOut}>
        <SettingsBody>
          <Button
            variant="quiet"
            label={earthCopy.signOut}
            onPress={() => setConfirmingSignOut(true)}
          />
        </SettingsBody>
      </View>
      <Sheet
        open={confirmingSignOut}
        onClose={() => setConfirmingSignOut(false)}
        title={youCopy.signOutConfirm}
      >
        <View style={styles.actions}>
          <Button
            variant="primary"
            fullWidth
            loading={busy}
            label={earthCopy.signOut}
            onPress={() => void signOut()}
          />
          <Button
            variant="quiet"
            fullWidth
            label={copy.notNow}
            onPress={() => setConfirmingSignOut(false)}
          />
        </View>
      </Sheet>
    </SettingsFrame>
  )
}

const styles = StyleSheet.create({
  list: { paddingVertical: space[2] },
  signOut: { paddingTop: space[6] },
  actions: { gap: space[2] },
})
