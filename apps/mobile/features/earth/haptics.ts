/**
 * A light tap on primary actions (share, stop sharing, block, report, save). Guarded: a device or
 * preview without haptics does nothing.
 */
import * as Haptics from 'expo-haptics'

export function lightTap(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined)
}

export function selectionTap(): void {
  Haptics.selectionAsync().catch(() => undefined)
}
