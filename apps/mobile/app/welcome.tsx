/**
 * Spec §49 — "You're on Earth." White, centered, the person's name and face, a very restrained
 * point of motion, and one CTA: "Enter Weekend Crew" straight into the group's conversation.
 */
import { APP_NAME, colors, copy, motion, radius, space, spacing } from '@earth/ui'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useEffect, useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { text } from '@/components/ui/text'
import {
  consumeCompletion,
  getCompletionSnapshot,
  subscribeCompletion,
} from '@/lib/claim/completionStore'
import { destinationAfterClaim, enterGroupLabel } from '@/lib/claim/flow'
import { shellCopy } from '@/lib/copy'
import { success } from '@/lib/haptics'
import { useEarth, useSession } from '@/lib/providers'
import { usePushInterest } from '@/lib/push'
import { ROUTES } from '@/lib/routes'

const enterEasing = Easing.bezier(...motion.curve.enter)

function Rise({ delay, children }: { readonly delay: number; readonly children: React.ReactNode }) {
  const progress = useSharedValue(0)
  useEffect(() => {
    progress.value = withDelay(
      delay,
      withTiming(1, { duration: motion.duration.slow, easing: enterEasing }),
    )
  }, [delay, progress])
  const style = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * space[2] }],
  }))
  return <Animated.View style={[styles.rise, style]}>{children}</Animated.View>
}

export default function WelcomeScreen() {
  const earth = useEarth()
  const session = useSession()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const markPushInterest = usePushInterest()
  const completion = useSyncExternalStore(subscribeCompletion, getCompletionSnapshot)

  // Nobody lands here by accident: without a fresh completion, Humans go Home, others to the gate.
  useEffect(() => {
    if (completion !== null || session.status !== 'ready') return
    router.replace(session.roleKind === 'human' ? ROUTES.home : ROUTES.claim)
  }, [completion, session.status, session.roleKind, router])

  const groupId = completion?.groupId
  const group = useQuery({
    queryKey: ['group', groupId],
    queryFn: () => earth.groups.get(groupId as NonNullable<typeof groupId>),
    enabled: groupId !== undefined && session.roleKind === 'human',
  })

  if (completion === null) return <View style={styles.root} />

  const identity = session.identity
  const label = enterGroupLabel(group.data?.name ?? null, shellCopy.enterYourGroup)

  const enter = () => {
    // Something completed (the claim): a success haptic, then the first meaningful moment for
    // push (spec §85) on the way in.
    success()
    markPushInterest('claim_completed')
    consumeCompletion()
    router.replace(destinationAfterClaim(completion))
  }

  return (
    <View
      style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom + space[6] }]}
    >
      <Rise delay={0}>
        <View style={styles.dot} accessibilityElementsHidden importantForAccessibility="no" />
      </Rise>
      <Rise delay={motion.duration.fast}>
        <Text style={[text.display, text.primary, styles.center]} accessibilityRole="header">
          {copy.youreOnEarth}
        </Text>
        {identity !== null ? (
          <View style={styles.person}>
            <Avatar
              name={identity.displayName}
              src={identity.avatarUrl}
              size="profile"
              decorative
            />
            <Text style={[text.section, text.primary]}>{identity.displayName}</Text>
          </View>
        ) : null}
      </Rise>
      <Rise delay={motion.duration.base}>
        <Button
          variant="primary"
          fullWidth
          label={label}
          loading={group.isLoading}
          onPress={enter}
        />
      </Rise>
      <Text style={styles.hidden} accessibilityElementsHidden>
        {APP_NAME}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.screenMargin,
    gap: space[8],
  },
  rise: { width: '100%', maxWidth: 420, alignItems: 'center', gap: space[4] },
  dot: {
    width: space[3],
    height: space[3],
    borderRadius: radius.avatar,
    backgroundColor: colors.earthAccent,
  },
  center: { textAlign: 'center' },
  person: { alignItems: 'center', gap: space[3] },
  hidden: { position: 'absolute', opacity: 0, height: 0 },
})
