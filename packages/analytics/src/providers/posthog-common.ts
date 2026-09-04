/**
 * Shared shape of the stateful PostHog clients (`posthog-js` in browsers, `posthog-react-native`
 * on mobile). Both SDKs keep the current distinct id themselves, so the adapter only forwards.
 *
 * Injection design: this package never imports a PostHog SDK. The app constructs the SDK client
 * (with its own key/host from `@earth/config`) and hands the instance to the factory; the
 * structural type below lists the handful of methods used, so any SDK version with these
 * signatures works and `@earth/analytics` typechecks and tests without the SDKs installed.
 */
import type { EventName } from '../contract'
import { type AnalyticsIdentity, distinctIdFor } from '../identity'
import type { AnalyticsProperties, AnalyticsProvider } from '../provider'

export interface StatefulPostHogLike {
  capture(event: string, properties?: Record<string, unknown>): unknown
  identify(distinctId: string, properties?: Record<string, unknown>): unknown
  reset(): unknown
  flush?(): unknown
}

export interface StatefulPostHogProviderOptions {
  name: string
  client: StatefulPostHogLike
}

/** Person properties set on identify: ids only, never profile data. */
export function personPropertiesFor(identity: AnalyticsIdentity): Record<string, string> {
  const props: Record<string, string> = {}
  if (identity.humanId !== undefined) props['humanId'] = identity.humanId
  if (identity.guestSessionId !== undefined) props['guestSessionId'] = identity.guestSessionId
  if (identity.anonymousVisitorId !== undefined) {
    props['anonymousVisitorId'] = identity.anonymousVisitorId
  }
  return props
}

export function createStatefulPostHogProvider(
  options: StatefulPostHogProviderOptions,
): AnalyticsProvider {
  const { client } = options
  return {
    name: options.name,
    identify(identity: AnalyticsIdentity) {
      // Visitors keep the SDK's own anonymous id; identifying them would create person profiles
      // for every device. Their anonymousVisitorId still rides on every event as a property.
      const distinctId = identity.humanId ?? identity.guestSessionId
      if (distinctId === undefined) return
      client.identify(distinctId, personPropertiesFor(identity))
    },
    capture(name: EventName, properties: AnalyticsProperties) {
      client.capture(name, { ...properties })
    },
    reset() {
      client.reset()
    },
    async flush() {
      await client.flush?.()
    },
  }
}

export { distinctIdFor }
