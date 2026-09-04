/**
 * Which analytics adapters the app fans events out to (spec §13, ARCHITECTURE §2): PostHog when
 * `EXPO_PUBLIC_POSTHOG_KEY` is set, the console in development otherwise, noop in production
 * without a key — and always the first-party sink so the dashboard metrics (spec PART XVII)
 * never depend on a vendor. Pure selection so it is unit-tested; the SDK instance is injected.
 */
import {
  type AnalyticsClient,
  type AnalyticsIdentity,
  type AnalyticsPlatform,
  type AnalyticsProvider,
  type FetchLike,
  type PostHogReactNativeLike,
  createAnalytics,
  createBaseProperties,
  createConsoleProvider,
  createFirstPartyProvider,
  createNoopProvider,
  createPostHogReactNativeProvider,
} from '@earth/analytics'

export type MobileAnalyticsPlatform = Extract<AnalyticsPlatform, 'ios' | 'android'>

/** `Platform.OS` → the analytics platform; anything else (web preview) reports as Android. */
export function analyticsPlatformFor(os: string): MobileAnalyticsPlatform {
  return os === 'ios' ? 'ios' : 'android'
}

export interface SelectProvidersInput {
  readonly apiBaseUrl: string
  readonly fetch: FetchLike
  readonly getAccessToken: () => Promise<string | null>
  /** The constructed `posthog-react-native` instance, or `null` when there is no key. */
  readonly posthog: PostHogReactNativeLike | null
  readonly isDevelopment: boolean
}

export function selectAnalyticsProviders(input: SelectProvidersInput): AnalyticsProvider[] {
  const vendor: AnalyticsProvider =
    input.posthog !== null
      ? createPostHogReactNativeProvider(input.posthog)
      : input.isDevelopment
        ? createConsoleProvider()
        : createNoopProvider()
  const firstParty = createFirstPartyProvider({
    apiBaseUrl: input.apiBaseUrl,
    fetch: input.fetch,
    getAccessToken: input.getAccessToken,
  })
  return [vendor, firstParty]
}

export interface CreateMobileAnalyticsInput extends SelectProvidersInput {
  readonly appVersion: string
  readonly platform: MobileAnalyticsPlatform
  readonly identity: () => AnalyticsIdentity
  readonly now?: () => number
}

export function createMobileAnalytics(input: CreateMobileAnalyticsInput): AnalyticsClient {
  const baseOptions =
    input.now === undefined
      ? { appVersion: input.appVersion, platform: input.platform }
      : { appVersion: input.appVersion, platform: input.platform, now: input.now }
  return createAnalytics({
    providers: selectAnalyticsProviders(input),
    base: createBaseProperties(baseOptions),
    identity: input.identity,
    // A contract slip must never take a screen down; it is reported by the guard in tests.
    onForbiddenProperty: 'strip',
  })
}
