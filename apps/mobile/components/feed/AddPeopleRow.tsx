/**
 * SCREEN 02 zero-friends member state: "Add people you actually know" as a contextual row that
 * leads to search — never an onboarding takeover.
 */
import { avatarSize, colors, copy, radius, space, spacing, touchTarget } from '@earth/ui'
import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { Icon, text } from '@/components/ui'
import { feedCopy } from '@/features/feed/copy'
import { searchHref } from '@/features/feed/routes'

export function AddPeopleRow() {
  const router = useRouter()
  return (
    <Pressable
      onPress={() => router.push(searchHref())}
      accessibilityRole="button"
      accessibilityLabel={copy.addPeopleYouKnow}
      accessibilityHint={feedCopy.addPeopleBody}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.badge}>
        <Icon name="search" color={colors.textSecondary} />
      </View>
      <View style={styles.middle}>
        <Text style={[text.body, text.primary]}>{copy.addPeopleYouKnow}</Text>
        <Text style={[text.secondary, text.muted]}>{feedCopy.addPeopleBody}</Text>
      </View>
      <Icon name="chevron" size="small" color={colors.textSecondary} />
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
  badge: {
    width: avatarSize.medium,
    height: avatarSize.medium,
    borderRadius: radius.avatar,
    backgroundColor: colors.subtleFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  middle: { flex: 1, minWidth: 0 },
})
