/**
 * PostHog adapter for the server tier (`posthog-node`, peer of apps/web's route handlers).
 *
 * Injection design: no SDK import here. The server constructs
 * `new PostHog(env.POSTHOG_SERVER_KEY, { host })` and passes it in; `PostHogNodeLike` is the
 * structural subset we call. The Node SDK is stateless per person, so the distinct id is derived
 * from each event's merged identity properties (`humanId` → `guestSessionId` →
 * `anonymousVisitorId`) and falls back to `SERVER_DISTINCT_ID` for system events.
 *
 * Visitors and system events are captured with `$process_person_profile: false` so PostHog does not
 * mint a person profile per device / per server process (the same rule the stateful adapters apply
 * by never calling `identify` for Visitors; see `./posthog-common.ts`).
 */
import type { EventName } from '../contract'
import { type AnalyticsIdentity, distinctIdFor, identityFromProperties } from '../identity'
import type { AnalyticsProperties, AnalyticsProvider } from '../provider'
import { personPropertiesFor } from './posthog-common'

export const POSTHOG_NODE_PROVIDER_NAME = 'posthog-node' as const
export const SERVER_DISTINCT_ID = 'server' as const
/** PostHog event property that suppresses person-profile creation for an event. */
export const POSTHOG_PROCESS_PERSON_PROFILE_KEY = '$process_person_profile' as const

export interface PostHogNodeLike {
  capture(message: {
    distinctId: string
    event: string
    properties?: Record<string, unknown>
    timestamp?: Date
  }): unknown
  identify(message: { distinctId: string; properties?: Record<string, unknown> }): unknown
  flush(): Promise<unknown>
}

function isIdentifiedPerson(identity: AnalyticsIdentity): boolean {
  return identity.humanId !== undefined || identity.guestSessionId !== undefined
}

export function createPostHogNodeProvider(posthog: PostHogNodeLike): AnalyticsProvider {
  return {
    name: POSTHOG_NODE_PROVIDER_NAME,
    identify(identity: AnalyticsIdentity) {
      const distinctId = identity.humanId ?? identity.guestSessionId
      if (distinctId === undefined) return
      posthog.identify({ distinctId, properties: personPropertiesFor(identity) })
    },
    capture(name: EventName, properties: AnalyticsProperties) {
      const identity = identityFromProperties(properties)
      const distinctId = distinctIdFor(identity) ?? SERVER_DISTINCT_ID
      const timestamp = properties['timestamp']
      const parsed = typeof timestamp === 'string' ? new Date(timestamp) : undefined
      const eventProperties: Record<string, unknown> = { ...properties }
      if (!isIdentifiedPerson(identity)) eventProperties[POSTHOG_PROCESS_PERSON_PROFILE_KEY] = false
      const message: Parameters<PostHogNodeLike['capture']>[0] = {
        distinctId,
        event: name,
        properties: eventProperties,
      }
      if (parsed !== undefined && !Number.isNaN(parsed.getTime())) message.timestamp = parsed
      posthog.capture(message)
    },
    reset: () => undefined,
    async flush() {
      await posthog.flush()
    },
  }
}
