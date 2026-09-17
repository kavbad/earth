/** Provider that discards everything — tests, Storybook, analytics opt-out. */
import type { AnalyticsProvider } from '../provider'

export const NOOP_PROVIDER_NAME = 'noop' as const

export function createNoopProvider(): AnalyticsProvider {
  return {
    name: NOOP_PROVIDER_NAME,
    identify: () => undefined,
    capture: () => undefined,
    reset: () => undefined,
    flush: () => Promise.resolve(),
  }
}
