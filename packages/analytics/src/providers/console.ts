/** Development provider: prints every call through an injected logger (defaults to `console`). */
import type { EventName } from '../contract'
import type { AnalyticsIdentity } from '../identity'
import type { AnalyticsProperties, AnalyticsProvider } from '../provider'

export const CONSOLE_PROVIDER_NAME = 'console' as const
export const CONSOLE_PROVIDER_PREFIX = '[analytics]' as const

export type ConsoleLogger = (message: string, ...details: unknown[]) => void

export interface ConsoleProviderOptions {
  log?: ConsoleLogger
  prefix?: string
}

export function createConsoleProvider(options: ConsoleProviderOptions = {}): AnalyticsProvider {
  const log: ConsoleLogger =
    options.log ?? ((message, ...details) => console.debug(message, ...details))
  const prefix = options.prefix ?? CONSOLE_PROVIDER_PREFIX
  return {
    name: CONSOLE_PROVIDER_NAME,
    identify(identity: AnalyticsIdentity) {
      log(`${prefix} identify`, identity)
    },
    capture(name: EventName, properties: AnalyticsProperties) {
      log(`${prefix} ${name}`, properties)
    },
    reset() {
      log(`${prefix} reset`)
    },
    flush: () => Promise.resolve(),
  }
}
