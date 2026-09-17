/**
 * Haptics on primary actions — light, never blocking; a device without an engine stays silent.
 * `useHaptics()` hands screens a stable object so a tap handler never re-renders for it.
 */
import * as Haptics from 'expo-haptics'

export function lightTap(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)
}

export function selectionTap(): void {
  Haptics.selectionAsync().catch(() => undefined)
}

export function success(): void {
  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
}

export interface HapticsApi {
  /** Primary actions: send, post, join, claim. */
  light(): void
  /** A choice changed: radius, audience, a segment. */
  selection(): void
  /** Something completed: a claim, a share. */
  success(): void
}

const HAPTICS: HapticsApi = { light: lightTap, selection: selectionTap, success }

export function useHaptics(): HapticsApi {
  return HAPTICS
}
