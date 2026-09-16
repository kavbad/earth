/**
 * The root of the app: URL polyfill for supabase-js, gesture root, the provider stack
 * (ARCHITECTURE §7, §12; spec §51, §96, §107), the splash held until the fonts and the session
 * are known, push
 * registration, and one stack whose first screen is the five tabs (spec §50). Every other route
 * (chats, rooms, posts, profiles, claim, invites) pushes on top of the tabs.
 */
import 'react-native-url-polyfill/auto'

import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
} from '@expo-google-fonts/instrument-sans'
import {
  Newsreader_400Regular,
  Newsreader_500Medium,
  Newsreader_600SemiBold,
} from '@expo-google-fonts/newsreader'
import { registerGlobals } from '@livekit/react-native'
import { colors, motion } from '@earth/ui'
import { useFonts } from 'expo-font'
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

/**
 * The two faces of spec §90, under the names `components/ui/text.ts` resolves (`fontFor`). Held
 * behind the splash with the session so the first frame is already set in them.
 */
const FONTS = {
  Newsreader_400Regular,
  Newsreader_500Medium,
  Newsreader_600SemiBold,
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
} as const

function SplashGate() {
  const session = useSession()
  useEffect(() => {
    if (session.status !== 'ready') return
    void SplashScreen.hideAsync().catch(() => undefined)
  }, [session.status])
  return null
}

export default function RootLayout() {
  // A font that fails to load is not worth a blank app: the system face stands in.
  const [fontsReady, fontError] = useFonts(FONTS)
  if (!fontsReady && fontError === null) return null
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
