/**
 * Which analytics adapters the web client fans events out to (spec §13, ARCHITECTURE §2):
 * PostHog when `NEXT_PUBLIC_POSTHOG_KEY` is set, the console in development otherwise, noop in
 * production without a key — and always the first-party sink so the dashboard metrics
 * (spec PART XVII) never depend on a vendor. Pure selection so it is unit-tested.
 */
import {
  type AnalyticsClient,
  type AnalyticsIdentity,
  type AnalyticsProvider,
  type FetchLike,
  type PostHogWebLike,
  createAnalytics,
  createBaseProperties,
  createConsoleProvider,
  createFirstPartyProvider,
  createNoopProvider,
  createPostHogWebProvider,
} from '@earth/analytics'

export const WEB_ANALYTICS_PLATFORM = 'web' as const

export interface SelectProvidersInput {
  readonly apiBaseUrl: string
  readonly fetch: FetchLike
  readonly getAccessToken: () => Promise<string | null>
  /** The initialised `posthog-js` instance, or `null` when there is no key. */
  readonly posthog: PostHogWebLike | null
  readonly isDevelopment: boolean
}

export function selectAnalyticsProviders(input: SelectProvidersInput): AnalyticsProvider[] {
  const vendor: AnalyticsProvider =
    input.posthog !== null
      ? createPostHogWebProvider(input.posthog)
      : input.isDevelopment
        ? createConsoleProvider()
        : createNoopProvider()
  const firstParty = createFirstPartyProvider({
    apiBaseUrl: input.apiBaseUrl,
    fetch: input.fetch,
    getAccessToken: input.getAccessToken,
    keepalive: true,
  })
  return [vendor, firstParty]
}

export interface CreateWebAnalyticsInput extends SelectProvidersInput {
  readonly appVersion: string
  readonly identity: () => AnalyticsIdentity
  readonly now?: () => number
}

export function createWebAnalytics(input: CreateWebAnalyticsInput): AnalyticsClient {
  const baseOptions =
    input.now === undefined
      ? { appVersion: input.appVersion, platform: WEB_ANALYTICS_PLATFORM }
      : { appVersion: input.appVersion, platform: WEB_ANALYTICS_PLATFORM, now: input.now }
  return createAnalytics({
    providers: selectAnalyticsProviders(input),
    base: createBaseProperties(baseOptions),
    identity: input.identity,
    // A contract slip must never take a screen down; it is reported by the guard in tests.
    onForbiddenProperty: 'strip',
  })
}
