/**
 * A `PushSender` for deployments without push credentials (`EXPO_ACCESS_TOKEN` unset): every
 * message is refused with a non-transient `ProviderError` ticket, so the dispatcher marks the
 * notifications handled (they stay in the app's notification list) instead of retrying forever.
 */
import type { PushSender } from '../deps'

export const PUSH_DISABLED_MESSAGE = 'push delivery is disabled' as const

export function createDisabledPushSender(): PushSender {
  return {
    async send(messages) {
      return messages.map(() => ({
        status: 'error' as const,
        message: PUSH_DISABLED_MESSAGE,
        details: { error: 'ProviderError' as const },
        transient: false,
      }))
    },
  }
}
