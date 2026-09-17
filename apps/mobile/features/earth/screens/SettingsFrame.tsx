/**
 * The frame of every Settings screen (SCREEN 25): a compact header with a back control, the
 * "Waiting for connection" line, then the content. Visitors and Guests never see settings
 * (spec §43): they meet the claim sheet instead. Plus the small shared pieces: a titled section,
 * a switch row, a note and an inline error.
 */
import { colors, copy, space, spacing, touchTarget } from '@earth/ui'
import { useRouter } from 'expo-router'
import { type ReactNode, useCallback } from 'react'
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native'

import { OfflineBanner } from '@/components/shell/OfflineBanner'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { Screen } from '@/components/ui/Screen'
import { ScreenHeader } from '@/components/ui/ScreenHeader'
import { Skeleton } from '@/components/ui/Skeleton'
import { text } from '@/components/ui/text'

import { youCopy } from '../copy'
import { CLAIM_ROUTE, YOU_ROUTES } from '../routes'
import { useEarthShell } from '../shell'

/** Back from a pushed settings screen: the previous screen, or the settings index / You tab. */
export function useSettingsBack(fallback: string = YOU_ROUTES.settings): () => void {
  const router = useRouter()
  return useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace(fallback)
  }, [router, fallback])
}

export interface SettingsFrameProps {
  readonly title: string
  readonly onBack: () => void
  readonly children: ReactNode
  /** The screen hosts text fields: keep them above the keyboard. */
  readonly avoidKeyboard?: boolean
}

export function SettingsFrame({
  title,
  onBack,
  children,
  avoidKeyboard = false,
}: SettingsFrameProps) {
  const shell = useEarthShell()
  const router = useRouter()
  const claiming = shell.roleKind === 'claiming'
  return (
    <Screen avoidKeyboard={avoidKeyboard}>
      <ScreenHeader
        title={title}
        leading={<IconButton name="back" label={youCopy.back} onPress={onBack} />}
      />
      <OfflineBanner />
      {shell.sessionStatus === 'loading' ? (
        <View style={styles.skeleton} accessibilityElementsHidden>
          <Skeleton width="50%" height={space[4]} />
          <Skeleton width="33%" height={space[4]} />
        </View>
      ) : !shell.isHuman ? (
        // A claiming Human finishes the claim (like the You tab); Visitors meet the claim sheet.
        <EmptyState
          title={claiming ? youCopy.finishClaim : youCopy.notOnEarthYet}
          action={
            claiming ? (
              <Button
                variant="primary"
                label={youCopy.finishClaim}
                onPress={() => router.push(CLAIM_ROUTE)}
              />
            ) : (
              <Button
                variant="primary"
                label={copy.claimYourPlace}
                onPress={() => shell.openClaim('profile')}
              />
            )
          }
        />
      ) : (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.content}
          contentInsetAdjustmentBehavior="never"
        >
          {children}
        </ScrollView>
      )}
    </Screen>
  )
}

/** A titled group of rows inside a settings screen. */
export function SettingsSection({
  title,
  hint,
  children,
}: {
  readonly title: string
  readonly hint?: string | undefined
  readonly children: ReactNode
}) {
  return (
    <View style={styles.section} accessibilityLabel={title}>
      <View style={styles.sectionHead}>
        <Text style={[text.section, text.primary]} accessibilityRole="header">
          {title}
        </Text>
        {hint !== undefined ? <Text style={[text.secondary, text.muted]}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  )
}

/** Content that sits at the screen margin (fields, buttons, notes). */
export function SettingsBody({ children }: { readonly children: ReactNode }) {
  return <View style={styles.body}>{children}</View>
}

export interface SwitchRowProps {
  readonly title: string
  readonly subtitle?: string | undefined
  readonly value: boolean
  readonly onValueChange: (next: boolean) => void
  readonly disabled?: boolean
}

/** A toggle row: the system switch, painted with the ink and separator tokens only. */
export function SwitchRow({
  title,
  subtitle,
  value,
  onValueChange,
  disabled = false,
}: SwitchRowProps) {
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text style={[text.body, text.primary]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle !== undefined ? (
          <Text style={[text.secondary, text.muted]} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        accessibilityRole="switch"
        accessibilityLabel={title}
        accessibilityState={{ checked: value, disabled }}
        trackColor={{ false: colors.separator, true: colors.textPrimary }}
        thumbColor={colors.background}
        ios_backgroundColor={colors.separator}
      />
    </View>
  )
}

export function Note({ children }: { readonly children: string }) {
  return <Text style={[text.meta, text.muted]}>{children}</Text>
}

export function InlineError({ message }: { readonly message: string | null }) {
  if (message === null) return null
  return (
    <Text style={[text.secondary, text.danger]} accessibilityLiveRegion="assertive">
      {message}
    </Text>
  )
}

export function StatusText({ children }: { readonly children: string }) {
  return (
    <Text style={[text.body, text.primary]} accessibilityLiveRegion="polite">
      {children}
    </Text>
  )
}

const styles = StyleSheet.create({
  skeleton: { paddingHorizontal: spacing.screenMargin, paddingVertical: space[6], gap: space[3] },
  content: { paddingBottom: space[10] },
  section: { paddingVertical: space[4], gap: space[2] },
  sectionHead: { paddingHorizontal: spacing.screenMargin, gap: space[1] },
  body: { paddingHorizontal: spacing.screenMargin, gap: space[3] },
  switchRow: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.rowGapLoose,
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[2],
  },
  switchText: { flex: 1, minWidth: 0 },
})
