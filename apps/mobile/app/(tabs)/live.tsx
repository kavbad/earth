/**
 * SCREEN 13 — Live Home: the same radius control as Home and Earth, then a clean list of Lives
 * named for the viewer. No autoplay, no full-screen swipe mode in V1.
 */
import { colors, copy } from '@earth/ui'
import { StyleSheet, View } from 'react-native'

import { LiveList } from '@/components/live/LiveList'
import { RadiusControl } from '@/components/shell/RadiusControl'
import { ScreenHeader } from '@/components/ui/ScreenHeader'

export default function LiveTab() {
  return (
    <View style={styles.screen}>
      <ScreenHeader title={copy.tabs.live} large>
        <RadiusControl surface="live" />
      </ScreenHeader>
      <LiveList />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
})
