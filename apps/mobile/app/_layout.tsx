/**
 * The root of the app: URL polyfill for supabase-js, gesture root, the provider stack
 * (ARCHITECTURE §7, §12; spec §51, §96, §107), the splash held until the session is known, push
 * registration, and one stack whose first screen is the five tabs (spec §50). Every other route
 * (chats, rooms, posts, profiles, claim, invites) pushes on top of the tabs.
 */
import 'react-native-url-polyfill/auto'

import { registerGlobals } from '@livekit/react-native'
import { colors, motion } from '@earth/ui'
import { SplashScreen, Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { StyleSheet } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import { PushRegistrar } from '@/components/shell/PushRegistrar'
import { getErrorMonitor } from '@/lib/observability/monitor'
import { EarthProviders, useSession } from '@/lib/providers'

// LiveKit needs the WebRTC globals before any room connects (spec §57).
registerGlobals()
// Sentry (when configured) must be up before the first render to see start-up crashes (spec §14).
getErrorMonitor()
void SplashScreen.preventAutoHideAsync().catch(() => undefined)

function SplashGate() {
  const session = useSession()
  useEffect(() => {
    if (session.status !== 'ready') return
    void SplashScreen.hideAsync().catch(() => undefined)
  }, [session.status])
  return null
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <EarthProviders>
        <StatusBar style="dark" />
        <SplashGate />
        <PushRegistrar />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.background },
            animationDuration: motion.duration.base,
          }}
        >
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="compose" options={{ presentation: 'modal' }} />
          <Stack.Screen
            name="rooms/[id]"
            options={{
              animation: 'fade',
              animationDuration: motion.duration.slow,
              gestureEnabled: false,
            }}
          />
        </Stack>
      </EarthProviders>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
})
