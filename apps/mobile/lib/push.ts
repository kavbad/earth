/**
 * The device side of push (spec §12; ARCHITECTURE §11): the interest store that marks the first
 * meaningful moment, the expo-notifications calls (permission, Android channels, the Expo token,
 * foreground presentation, listeners) behind small functions, and the pure decisions re-exported
 * from `./notifications/push`. `components/shell/PushRegistrar` wires it; nothing else imports
 * expo-notifications.
 */
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { create } from 'zustand'

import {
  type ChannelImportance,
  PUSH_CHANNEL_SPECS,
  type PushInterestReason,
  type PushPermission,
} from './notifications/push'

export * from './notifications/push'

// ---------------------------------------------------------------------------
// Interest (ephemeral UI state — zustand)
// ---------------------------------------------------------------------------

export interface PushInterestState {
  readonly interested: boolean
  readonly reason: PushInterestReason | null
  markInterest(reason: PushInterestReason): void
}

/** Interest lives for the app process; the OS remembers the answer it gave. */
export const usePushInterestStore = create<PushInterestState>()((set) => ({
  interested: false,
  reason: null,
  markInterest: (reason) =>
    set((state) => (state.interested ? state : { interested: true, reason })),
}))

/** `usePushInterest()('live')` — a screen says a meaningful moment happened (spec §85). */
export function usePushInterest(): (reason: PushInterestReason) => void {
  return usePushInterestStore((state) => state.markInterest)
}

/** The same, outside React. */
export function markPushInterest(reason: PushInterestReason): void {
  usePushInterestStore.getState().markInterest(reason)
}

// ---------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------

function permissionFrom(response: Notifications.NotificationPermissionsStatus): PushPermission {
  if (response.granted) return 'granted'
  return String(response.status) === 'undetermined' ? 'undetermined' : 'denied'
}

/** What the OS remembers, without asking. */
export async function readPushPermission(): Promise<PushPermission> {
  try {
    return permissionFrom(await Notifications.getPermissionsAsync())
  } catch {
    return 'denied'
  }
}

/** Shows the system prompt; call it only at a meaningful moment (`nextPushAction`). */
export async function requestPushPermission(): Promise<PushPermission> {
  try {
    return permissionFrom(await Notifications.requestPermissionsAsync())
  } catch {
    return 'denied'
  }
}

// ---------------------------------------------------------------------------
// Android channels and the token
// ---------------------------------------------------------------------------

const ANDROID_IMPORTANCE: Readonly<Record<ChannelImportance, Notifications.AndroidImportance>> = {
  low: Notifications.AndroidImportance.LOW,
  default: Notifications.AndroidImportance.DEFAULT,
  high: Notifications.AndroidImportance.HIGH,
}

/** Creates (or updates) the three channels the server addresses; a no-op on iOS. */
export async function ensureAndroidChannels(): Promise<void> {
  if (Platform.OS !== 'android') return
  for (const spec of PUSH_CHANNEL_SPECS) {
    await Notifications.setNotificationChannelAsync(spec.id, {
      name: spec.name,
      importance: ANDROID_IMPORTANCE[spec.importance],
      sound: spec.sound ? 'default' : null,
    })
  }
}

export function easProjectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined
  const id = extra?.eas?.projectId
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/** The Expo push token of this install, or `null` when the device cannot provide one. */
export async function readExpoPushToken(): Promise<string | null> {
  try {
    const projectId = easProjectId()
    const token = await Notifications.getExpoPushTokenAsync(
      projectId === undefined ? {} : { projectId },
    )
    return token.data
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Presentation and listeners
// ---------------------------------------------------------------------------

/**
 * A push that arrives while the app is open is shown by the shell as one quiet line; the OS
 * keeps it in the list without a banner, a sound or a badge.
 */
export function configureForegroundPresentation(): void {
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldShowBanner: false,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
  })
}

export interface ForegroundPush {
  readonly title: string | null
  readonly body: string | null
  readonly data: unknown
}

/** Pushes received while the app is in the foreground. Returns the unsubscribe function. */
export function subscribeForegroundPush(listener: (push: ForegroundPush) => void): () => void {
  const subscription = Notifications.addNotificationReceivedListener((notification) => {
    const content = notification.request.content
    listener({ title: content.title, body: content.body, data: content.data })
  })
  return () => subscription.remove()
}

/**
 * Taps on a notification — the one that launched the app (delivered once, at subscription) and
 * every later one. Returns the unsubscribe function.
 */
export function subscribePushTaps(listener: (data: unknown) => void): () => void {
  let active = true
  const open = (response: Notifications.NotificationResponse | null) => {
    if (!active || response === null) return
    listener(response.notification.request.content.data)
  }
  void Notifications.getLastNotificationResponseAsync()
    .then(open)
    .catch(() => undefined)
  const subscription = Notifications.addNotificationResponseReceivedListener(open)
  return () => {
    active = false
    subscription.remove()
  }
}
