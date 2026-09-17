/**
 * Push on the device (spec §12, §85; ARCHITECTURE §11), wired from `lib/push.ts`. Renders nothing.
 *
 * - Permission is asked only of a Human, on a real online device, at the first meaningful moment
 *   (`usePushInterestStore`: after a claim, the Live tab, a room, Notifications) — never on app
 *   open, never of a Visitor. What the OS already granted registers silently.
 * - The Expo token goes to `push_token_register` and is re-sent when it or the Human changes.
 * - A push in the foreground is one quiet line, unless it names where the person already is.
 * - A tap (app closed, backgrounded or open) opens the room, conversation or post it names.
 */
import * as Device from 'expo-device'
import { usePathname, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'

import { useToast } from '@/components/ui/Toast'
import { routeForPushData } from '@/lib/deeplinks'
import { useOnline } from '@/lib/providers/OfflineProvider'
import { useEarth, useRuntime } from '@/lib/providers/RuntimeProvider'
import { useSession } from '@/lib/providers/SessionProvider'
import {
  INITIAL_PUSH_STATE,
  type PushRegistrationState,
  configureForegroundPresentation,
  ensureAndroidChannels,
  foregroundLine,
  interestReasonForPathname,
  needsRegistration,
  nextPushAction,
  pushPlatformFor,
  readExpoPushToken,
  readPushPermission,
  registrationKey,
  requestPushPermission,
  shouldPresentInForeground,
  subscribeForegroundPush,
  subscribePushTaps,
  usePushInterestStore,
} from '@/lib/push'

configureForegroundPresentation()

export function PushRegistrar() {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const session = useSession()
  const online = useOnline()
  const router = useRouter()
  const pathname = usePathname()
  const toast = useToast()
  const interested = usePushInterestStore((state) => state.interested)
  const markInterest = usePushInterestStore((state) => state.markInterest)
  const state = useRef<PushRegistrationState>(INITIAL_PUSH_STATE)
  const busy = useRef(false)
  const pathnameRef = useRef(pathname)
  // Bumped after the OS answered so the next step (ask, register) runs at once.
  const [pass, setPass] = useState(0)

  useEffect(() => {
    pathnameRef.current = pathname
  }, [pathname])

  const humanId =
    session.status === 'ready' && session.roleKind === 'human' ? session.humanId : null

  // Interest from the shell's own surfaces: the Live tab, a room, Notifications.
  useEffect(() => {
    const reason = interestReasonForPathname(pathname)
    if (reason !== null) markInterest(reason)
  }, [pathname, markInterest])

  useEffect(() => {
    if (runtime === null || busy.current || humanId === null) return
    const action = nextPushAction({
      humanId,
      isDevice: Device.isDevice,
      online,
      interested,
      state: state.current,
    })
    if (action === 'none') return
    busy.current = true
    const run = async () => {
      let again = false
      try {
        if (action === 'read_permission') {
          state.current = { ...state.current, permission: await readPushPermission() }
          again = true
        } else if (action === 'request_permission') {
          state.current = { ...state.current, permission: await requestPushPermission() }
          again = true
        } else {
          await ensureAndroidChannels()
          const token = await readExpoPushToken()
          if (token !== null && needsRegistration(state.current, humanId, token)) {
            await earth.notifications.registerPushToken({
              token,
              platform: pushPlatformFor(Platform.OS),
            })
            state.current = { ...state.current, registeredKey: registrationKey(humanId, token) }
          }
        }
      } catch {
        // Retried on the next session, interest or connectivity change.
      } finally {
        busy.current = false
      }
      if (again) setPass((count) => count + 1)
    }
    void run()
  }, [runtime, earth, humanId, online, interested, pass])

  // A push in the foreground: one quiet line, unless it names where the person already is.
  useEffect(
    () =>
      subscribeForegroundPush((push) => {
        if (!shouldPresentInForeground(push.data, pathnameRef.current)) return
        const line = foregroundLine(push.title, push.body)
        if (line !== null) toast.show(line)
      }),
    [toast],
  )

  // A tap on a notification opens what it names.
  useEffect(() => subscribePushTaps((data) => router.push(routeForPushData(data))), [router])

  return null
}
