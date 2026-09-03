/**
 * The app's own unmatched screen (spec §112): a link or a push that names nothing Earth knows
 * lands here instead of expo-router's default "Unmatched Route" page — white, one true line,
 * and the way back. Reached only through a system link or a stale route; never navigated to.
 */
import { colors } from '@earth/ui'
import { useRouter } from 'expo-router'
import { StyleSheet, View } from 'react-native'

import { Button, EmptyState, IconButton, ScreenHeader } from '@/components/ui'
import { shellCopy } from '@/lib/copy'
import { ROUTES } from '@/lib/routes'

export default function NotFoundScreen() {
  const router = useRouter()
  const back = () => {
    if (router.canGoBack()) router.back()
    else router.replace(ROUTES.home)
  }
  return (
    <View style={styles.screen}>
      <ScreenHeader
        title=""
        leading={<IconButton name="back" label={shellCopy.back} onPress={back} />}
      />
      <EmptyState
        title={shellCopy.notFound}
        action={
          <Button
            variant="quiet"
            label={shellCopy.backToEarth}
            onPress={() => router.replace(ROUTES.home)}
          />
        }
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
})
