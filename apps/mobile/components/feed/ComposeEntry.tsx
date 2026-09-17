/**
 * SCREEN 06 entry from Home: a quiet row with the person's face and "Say something" that opens
 * the composer with the current radius as the default audience. No floating create button.
 */
import type { Scope } from '@earth/domain'
import { colors, radius, space, spacing, touchTarget } from '@earth/ui'
import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { Avatar, text } from '@/components/ui'
import { feedCopy } from '@/features/feed/copy'
import { composeHref } from '@/features/feed/routes'
import { useFeedShell } from '@/features/feed/shell'

export function ComposeEntry({ scope }: { readonly scope: Scope }) {
  const shell = useFeedShell()
  const router = useRouter()
  const identity = shell.identity
  if (!shell.isHuman || identity === null) return null
  return (
    <Pressable
      onPress={() => router.push(composeHref({ audience: scope }))}
      accessibilityRole="button"
      accessibilityLabel={feedCopy.newPost}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Avatar name={identity.displayName} src={identity.avatarUrl} decorative />
      <View style={styles.field}>
        <Text style={[text.body, text.muted]}>{feedCopy.composeEntry}</Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: touchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[3],
  },
  pressed: { backgroundColor: colors.subtleFill },
  field: {
    flex: 1,
    minHeight: space[10],
    justifyContent: 'center',
    paddingHorizontal: space[4],
    borderRadius: radius.medium,
    backgroundColor: colors.subtleFill,
  },
})
