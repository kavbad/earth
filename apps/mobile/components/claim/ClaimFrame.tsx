/**
 * The claim flow's quiet chrome: the wordmark, one narrow column, nothing else (spec §88). Each
 * claim screen renders inside it; the column keeps clear of the keyboard, scrolls when a screen
 * is taller than the viewport, and shows a spinner until the flow has resolved where it is.
 */
import { APP_NAME, colors, space, spacing, touchTarget } from '@earth/ui'
import { useRouter } from 'expo-router'
import type { ReactNode } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { OfflineBanner } from '@/components/shell/OfflineBanner'
import { Spinner } from '@/components/ui/Spinner'
import { text } from '@/components/ui/text'
import { shellCopy } from '@/lib/copy'
import { ROUTES } from '@/lib/routes'

import { useClaimFlow } from './ClaimFlowProvider'

export function ClaimFrame({ children }: { readonly children: ReactNode }) {
  const { ready } = useClaimFlow()
  const insets = useSafeAreaInsets()
  const router = useRouter()
  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[styles.header, { paddingTop: insets.top }]}>
        <Pressable
          onPress={() => router.replace(ROUTES.home)}
          accessibilityRole="link"
          accessibilityLabel={shellCopy.backToEarth}
          hitSlop={space[2]}
          style={styles.wordmark}
        >
          <Text style={[text.title, text.primary]}>{APP_NAME}</Text>
        </Pressable>
      </View>
      {/* The claim flow lives outside the tabs: "Waiting for connection" is repeated here (spec §107). */}
      <OfflineBanner />
      {ready ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.column, { paddingBottom: insets.bottom + space[6] }]}
        >
          {children}
        </ScrollView>
      ) : (
        <Spinner fill label={shellCopy.loading} />
      )}
    </KeyboardAvoidingView>
  )
}

export function ClaimTitle({ children }: { readonly children: ReactNode }) {
  return (
    <Text style={[text.title, text.primary, styles.title]} accessibilityRole="header">
      {children}
    </Text>
  )
}

export function ClaimBody({
  children,
  danger = false,
}: {
  readonly children: ReactNode
  readonly danger?: boolean
}) {
  return (
    <Text
      style={[text.body, danger ? text.danger : text.muted]}
      {...(danger ? { accessibilityLiveRegion: 'polite' as const } : {})}
    >
      {children}
    </Text>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: spacing.screenMargin },
  wordmark: { minHeight: touchTarget, justifyContent: 'center', alignSelf: 'flex-start' },
  column: {
    flexGrow: 1,
    paddingHorizontal: spacing.screenMargin,
    paddingTop: space[6],
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
    gap: space[3],
  },
  title: { marginBottom: space[3] },
})
