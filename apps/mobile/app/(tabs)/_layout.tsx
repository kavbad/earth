/**
 * The member shell (spec §50): Home · Chats · Live · Earth · You behind one bottom navigation.
 * "Waiting for connection" sits above the content while offline (spec §107).
 */
import { colors } from '@earth/ui'
import { Tabs } from 'expo-router'
import { StyleSheet, View } from 'react-native'

import { OfflineBanner } from '@/components/shell/OfflineBanner'
import { TabBar } from '@/components/shell/TabBar'

export default function TabsLayout() {
  return (
    <View style={styles.root}>
      <OfflineBanner />
      <Tabs
        tabBar={(props) => <TabBar {...props} />}
        screenOptions={{
          headerShown: false,
          sceneStyle: { backgroundColor: colors.background },
          lazy: true,
        }}
      >
        <Tabs.Screen name="home" />
        <Tabs.Screen name="chats" />
        <Tabs.Screen name="live" />
        <Tabs.Screen name="earth" />
        <Tabs.Screen name="you" />
      </Tabs>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
})
