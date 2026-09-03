/**
 * Group invite deep link (spec §46–§47, §112): the preview — "Weekend Crew — Maya, Xavier + 5
 * others", faces, member count — for anyone, then "Join them".
 */
import type { GroupInvitePreviewDto } from '@earth/domain'
import { APP_NAME, colors, copy, participantSummary, space, spacing, touchTarget } from '@earth/ui'
import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { JoinInvite } from '@/components/invites/JoinInvite'
import { Button } from '@/components/ui/Button'
import { FaceStack } from '@/components/ui/FaceStack'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusLine } from '@/components/ui/StatusLine'
import { text } from '@/components/ui/text'
import { shellCopy } from '@/lib/copy'
import { useEarth, useOnline, useRuntime } from '@/lib/providers'
import { ROUTES, firstParam } from '@/lib/routes'

function previewTitle(preview: GroupInvitePreviewDto): string {
  const names = preview.sampleMembers.map((member) => member.displayName)
  return copy.invitePreviewTitle(preview.groupName, participantSummary(names, preview.memberCount))
}

export default function GroupInviteScreen() {
  const params = useLocalSearchParams<{ token?: string | string[] }>()
  const token = firstParam(params.token)
  const earth = useEarth()
  const { runtime } = useRuntime()
  const online = useOnline()
  const router = useRouter()
  const insets = useSafeAreaInsets()

  const preview = useQuery({
    queryKey: ['group-invite', token],
    queryFn: () => earth.groups.invites.preview(token ?? ''),
    enabled: runtime !== null && token !== null,
    retry: false,
  })

  const home = () => router.replace(ROUTES.home)

  return (
    <View
      style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom + space[6] }]}
    >
      <Pressable
        onPress={home}
        accessibilityRole="link"
        accessibilityLabel={shellCopy.backToEarth}
        style={styles.wordmark}
      >
        <Text style={[text.title, text.primary]}>{APP_NAME}</Text>
      </Pressable>
      {token === null || preview.isError ? (
        <View style={styles.section}>
          <Text style={[text.title, text.primary]} accessibilityRole="header">
            {online || token === null ? shellCopy.inviteNotFound : copy.waitingForConnection}
          </Text>
          {!online && token !== null ? (
            // Offline the link may still be good: say so and offer to try again (spec §107, §110).
            <StatusLine
              message={copy.waitingForConnection}
              actionLabel={shellCopy.retry}
              onAction={() => void preview.refetch()}
            />
          ) : null}
          <Button variant="quiet" label={shellCopy.backToEarth} onPress={home} />
        </View>
      ) : preview.data === undefined ? (
        <View style={styles.section} accessibilityLabel={shellCopy.loading}>
          {!online ? <StatusLine banner message={copy.waitingForConnection} /> : null}
          <Skeleton width={space[16]} height={space[16]} round />
          <Skeleton width="70%" height={space[6]} />
          <Skeleton width="40%" height={space[4]} />
        </View>
      ) : (
        <View style={styles.section}>
          {!online ? <StatusLine banner message={copy.waitingForConnection} /> : null}
          {preview.data.sampleMembers.length > 0 ? (
            <FaceStack
              people={preview.data.sampleMembers}
              total={preview.data.memberCount}
              size="large"
              label={participantSummary(
                preview.data.sampleMembers.map((member) => member.displayName),
                preview.data.memberCount,
              )}
            />
          ) : null}
          <Text style={[text.title, text.primary]} accessibilityRole="header">
            {previewTitle(preview.data)}
          </Text>
          <Text style={[text.secondary, text.muted]}>
            {shellCopy.inviteMembers(preview.data.memberCount)}
          </Text>
          <JoinInvite
            token={token}
            alreadyMember={preview.data.alreadyMember}
            expired={preview.data.expired}
          />
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.screenMargin },
  wordmark: { minHeight: touchTarget, justifyContent: 'center', alignSelf: 'flex-start' },
  section: {
    paddingVertical: space[8],
    gap: space[4],
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
})
