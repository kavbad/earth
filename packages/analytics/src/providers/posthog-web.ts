/**
 * PostHog adapter for the web app (`posthog-js`, peer of apps/web).
 *
 * Injection design: no SDK import here. apps/web does
 * `posthog.init(env.POSTHOG_KEY, { api_host: env.POSTHOG_HOST })` and passes the `posthog`
 * instance in; `PostHogWebLike` is the structural subset we call. This keeps `@earth/analytics`
 * free of browser globals and lets the package typecheck and test without `posthog-js` installed.
 */
import type { AnalyticsProvider } from '../provider'
import { createStatefulPostHogProvider, type StatefulPostHogLike } from './posthog-common'

export const POSTHOG_WEB_PROVIDER_NAME = 'posthog-web' as const

export type PostHogWebLike = StatefulPostHogLike

export function createPostHogWebProvider(posthog: PostHogWebLike): AnalyticsProvider {
  return createStatefulPostHogProvider({ name: POSTHOG_WEB_PROVIDER_NAME, client: posthog })
}
