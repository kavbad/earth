/** The `expo-haptics` test double: haptics are hardware, so every call resolves and does nothing. */
export const ImpactFeedbackStyle = { Light: 'light', Medium: 'medium', Heavy: 'heavy' } as const
export const NotificationFeedbackType = {
  Success: 'success',
  Warning: 'warning',
  Error: 'error',
} as const
export const impactAsync = (): Promise<void> => Promise.resolve()
export const selectionAsync = (): Promise<void> => Promise.resolve()
export const notificationAsync = (): Promise<void> => Promise.resolve()
