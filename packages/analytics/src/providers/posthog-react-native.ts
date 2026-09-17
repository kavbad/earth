/**
 * PostHog adapter for the mobile app (`posthog-react-native`, peer of apps/mobile).
 *
 * Injection design: no SDK import here. apps/mobile constructs
 * `new PostHog(env.POSTHOG_KEY, { host: env.POSTHOG_HOST })` and passes the instance in;
 * `PostHogReactNativeLike` is the structural subset we call, so the package typechecks and tests
 * without the SDK (and its native modules) installed.
 */
import type { AnalyticsProvider } from '../provider'
import { createStatefulPostHogProvider, type StatefulPostHogLike } from './posthog-common'

export const POSTHOG_REACT_NATIVE_PROVIDER_NAME = 'posthog-react-native' as const

export type PostHogReactNativeLike = StatefulPostHogLike

export function createPostHogReactNativeProvider(
  posthog: PostHogReactNativeLike,
): AnalyticsProvider {
  return createStatefulPostHogProvider({
    name: POSTHOG_REACT_NATIVE_PROVIDER_NAME,
    client: posthog,
  })
}
