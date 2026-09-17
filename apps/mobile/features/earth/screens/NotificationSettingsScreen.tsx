/**
 * SCREEN 25 → Notifications: the push permission as the OS remembers it (ask, or open Settings),
 * the four categories (spec §86) kept on this device, and a per-conversation list that leads to
 * each chat's info screen (SCREEN 12) where mute and notification level live.
 */
import { colors, copy, space, spacing } from '@earth/ui'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { StyleSheet, Text, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { Icon } from '@/components/ui/Icon'
import { ListRow } from '@/components/ui/ListRow'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusLine } from '@/components/ui/StatusLine'
import { text } from '@/components/ui/text'

import { earthCopy, youCopy } from '../copy'
import { selectionTap } from '../haptics'
import { useNotificationPrefs } from '../hooks/useDevicePrefs'
import { usePushPermission } from '../hooks/usePushPermission'
import { conversationInfoRoute } from '../routes'
import { useEarthShell } from '../shell'
import { NOTIFICATION_CATEGORIES, type PushPermissionState } from '../state/prefs'
import {
  Note,
  SettingsBody,
  SettingsFrame,
  SettingsSection,
  SwitchRow,
  useSettingsBack,
} from './SettingsFrame'

const items = copy.settings.sections.notifications.items
export const CONVERSATION_PREFS_QUERY_KEY = ['conversations', 'prefs'] as const

export function pushStateLabel(state: PushPermissionState): string {
  switch (state) {
    case 'granted':
      return youCopy.pushOn
    case 'undetermined':
      return youCopy.pushUndetermined
    case 'denied':
    case 'blocked':
      return youCopy.pushOff
    case 'unknown':
      return ''
    default: {
      const exhaustive: never = state
      throw new Error(`Unknown push state: ${String(exhaustive)}`)
    }
  }
}

export function NotificationSettingsScreen() {
  const shell = useEarthShell()
  const back = useSettingsBack()
  const router = useRouter()
  const push = usePushPermission()
  const prefs = useNotificationPrefs(shell.viewerId)
  const conversations = useQuery({
    queryKey: [...CONVERSATION_PREFS_QUERY_KEY, shell.viewerId],
    queryFn: () => shell.earth.conversations.list({}),
    enabled: shell.ready && shell.isHuman,
    staleTime: 60_000,
  })

  return (
    <SettingsFrame title={copy.settings.sections.notifications.title} onBack={back}>
      <SettingsSection
        title={youCopy.pushTitle}
        hint={push.state === 'blocked' ? youCopy.pushDeniedHint : youCopy.pushOffHint}
      >
        <ListRow
          title={youCopy.pushTitle}
          subtitle={pushStateLabel(push.state)}
          separator={false}
          {...(push.action === 'ask'
            ? {
                trailing: (
                  <Button
                    variant="secondary"
                    compact
                    loading={push.busy}
                    label={youCopy.allowNotifications}
                    onPress={() => void push.ask()}
                  />
                ),
              }
            : push.action === 'settings'
              ? {
                  trailing: (
                    <Button
                      variant="quiet"
                      compact
                      label={youCopy.openSettings}
                      onPress={() => void push.openSettings()}
                    />
                  ),
                }
              : {})}
        />
      </SettingsSection>
      <SettingsSection title={copy.settings.sections.notifications.title}>
        {NOTIFICATION_CATEGORIES.map((category) => (
          <SwitchRow
            key={category}
            title={items[category]}
            subtitle={youCopy.categoryHint[category]}
            value={prefs.value[category]}
            onValueChange={(enabled) => {
              selectionTap()
              prefs.dispatch({ type: 'set', category, enabled })
            }}
          />
        ))}
        <SettingsBody>
          <Note>{youCopy.storedOnDevice}</Note>
        </SettingsBody>
      </SettingsSection>
      <SettingsSection title={youCopy.perConversation} hint={youCopy.perConversationHint}>
        {conversations.data === undefined ? (
          conversations.isError ? (
            <StatusLine
              message={copy.couldntRefresh}
              actionLabel={earthCopy.retry}
              onAction={() => void conversations.refetch()}
            />
          ) : (
            <View style={styles.skeleton} accessibilityElementsHidden>
              <Skeleton width="50%" height={space[4]} />
              <Skeleton width="33%" height={space[4]} />
            </View>
          )
        ) : conversations.data.conversations.length === 0 ? (
          <SettingsBody>
            <Text style={[text.secondary, text.muted]}>{youCopy.noChatsYet}</Text>
          </SettingsBody>
        ) : (
          conversations.data.conversations.map((conversation, index, all) => (
            <ListRow
              key={conversation.id}
              title={conversation.title}
              subtitle={youCopy.conversationPrefsLine}
              separator={index < all.length - 1}
              trailing={<Icon name="chevron" size="small" color={colors.textSecondary} />}
              onPress={() => router.push(conversationInfoRoute(conversation.id))}
            />
          ))
        )}
      </SettingsSection>
    </SettingsFrame>
  )
}

const styles = StyleSheet.create({
  skeleton: { paddingHorizontal: spacing.screenMargin, gap: space[3] },
})
