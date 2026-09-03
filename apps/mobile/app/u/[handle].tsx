/**
 * `/u/[handle]` — SCREEN 22; the public `/@handle` link (spec §112) is rewritten here by
 * `app/+native-intent.tsx`. Keyed by handle so moving between profiles remounts the screen.
 */
import { colors } from '@earth/ui'
import { useLocalSearchParams } from 'expo-router'
import { StyleSheet, View } from 'react-native'

import { ProfileScreen } from '@/components/profile/ProfileScreen'
import { EmptyState, IconButton, ScreenHeader } from '@/components/ui'
import { feedCopy, profileCopy } from '@/features/feed/copy'
import { useBack } from '@/features/feed/hooks/useBack'
import { bareHandle, firstParam } from '@/features/feed/routes'

export default function ProfileRoute() {
  const params = useLocalSearchParams<{ handle?: string | string[] }>()
  const back = useBack()
  const handle = bareHandle(firstParam(params.handle) ?? '')
  if (handle.length === 0) {
    return (
      <View style={styles.screen}>
        <ScreenHeader
          title=""
          leading={<IconButton name="back" label={feedCopy.back} onPress={back} />}
        />
        <EmptyState title={profileCopy.profileUnavailable} />
      </View>
    )
  }
  return <ProfileScreen key={handle} handle={handle} />
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
})
