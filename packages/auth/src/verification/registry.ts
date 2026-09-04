/**
 * Chooses the HumanVerificationProvider for a deployment (ARCHITECTURE §6 `ServerDeps.verification`,
 * §14 environment rules):
 *
 * - `mock` is only built when `APP_ENV` is on the {@link MOCK_ALLOWED_APP_ENVS} allow-list
 *   (`development`, `preview`); `production`, a typo or a missing value are all refused, and
 *   the mock constructor re-checks, so there is no code path that hands production a fake
 *   verifier (spec §15, §77).
 * - `vendor` needs `HUMAN_VERIFICATION_VENDOR_URL` and `HUMAN_VERIFICATION_VENDOR_KEY`; a
 *   missing value is a configuration error, never a silent switch to another provider.
 * - `manual_review` needs the review callbacks the server tier wires to `identity_reviews`.
 */
import {
  type AppEnv,
  type HumanVerificationProviderKind,
  HumanVerificationProviders,
} from '@earth/config'

import {
  ManualReviewVerificationProvider,
  type ManualReviewVerificationProviderDeps,
} from './manual-review'
import { MockHumanVerificationProvider, type MockHumanVerificationProviderOptions } from './mock'
import {
  type HumanVerificationProvider,
  MOCK_ALLOWED_APP_ENVS,
  VerificationConfigError,
  isMockAllowedAppEnv,
} from './types'
import {
  type FetchLike,
  type SubtleCryptoLike,
  VendorHumanVerificationProvider,
  type VendorHumanVerificationProviderOptions,
} from './vendor'

/** The server-environment subset the registry reads (`ServerEnv` in `@earth/config` satisfies it). */
export interface VerificationProviderEnv {
  readonly HUMAN_VERIFICATION_PROVIDER: HumanVerificationProviderKind
  readonly APP_ENV: AppEnv
  readonly HUMAN_VERIFICATION_VENDOR_URL?: string | undefined
  readonly HUMAN_VERIFICATION_VENDOR_KEY?: string | undefined
  readonly HUMAN_VERIFICATION_WEBHOOK_SECRET?: string | undefined
}

export interface VerificationProviderDeps {
  /** Review callbacks; required for `manual_review`. */
  readonly manualReview?: Pick<
    ManualReviewVerificationProviderDeps,
    'createReview' | 'getReviewStatus'
  >
  /** HTTP for the vendor adapter. Defaults to `globalThis.fetch`. */
  readonly fetch?: FetchLike
  readonly subtle?: SubtleCryptoLike
  readonly now?: () => Date
  /** Mock tuning (development only). */
  readonly mock?: Pick<
    MockHumanVerificationProviderOptions,
    'defaultOutcome' | 'delayMs' | 'sessionTtlMs' | 'duplicateOfHumanId' | 'nextSessionId'
  >
  /** Vendor tuning beyond the environment variables. */
  readonly vendor?: Pick<
    VendorHumanVerificationProviderOptions,
    'statusMap' | 'duplicateStatuses' | 'timeoutMs' | 'signatureHeaderName'
  >
}

function hasValue(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

export function createVerificationProvider(
  env: VerificationProviderEnv,
  deps: VerificationProviderDeps = {},
): HumanVerificationProvider {
  const kind = env.HUMAN_VERIFICATION_PROVIDER
  const now = deps.now
  switch (kind) {
    case HumanVerificationProviders.mock: {
      if (!isMockAllowedAppEnv(env.APP_ENV)) {
        throw new VerificationConfigError(
          kind,
          `HUMAN_VERIFICATION_PROVIDER=${kind} is only allowed when APP_ENV is one of ${MOCK_ALLOWED_APP_ENVS.join(', ')} (got ${JSON.stringify(env.APP_ENV)}); use ${HumanVerificationProviders.manual_review} or ${HumanVerificationProviders.vendor}.`,
          env.APP_ENV,
        )
      }
      // `appEnv` comes last so nothing in `deps.mock` (typed away, but a runtime object) can
      // replace the environment that was just checked.
      return new MockHumanVerificationProvider({
        ...deps.mock,
        ...(now === undefined ? {} : { now }),
        appEnv: env.APP_ENV,
      })
    }
    case HumanVerificationProviders.vendor: {
      if (
        !hasValue(env.HUMAN_VERIFICATION_VENDOR_URL) ||
        !hasValue(env.HUMAN_VERIFICATION_VENDOR_KEY)
      ) {
        throw new VerificationConfigError(
          kind,
          `HUMAN_VERIFICATION_PROVIDER=${kind} requires HUMAN_VERIFICATION_VENDOR_URL and HUMAN_VERIFICATION_VENDOR_KEY.`,
          env.APP_ENV,
        )
      }
      const fetchImpl = deps.fetch ?? defaultFetch()
      if (fetchImpl === undefined) {
        throw new VerificationConfigError(
          kind,
          'No fetch implementation is available for the vendor verification provider.',
          env.APP_ENV,
        )
      }
      return new VendorHumanVerificationProvider({
        baseUrl: env.HUMAN_VERIFICATION_VENDOR_URL,
        apiKey: env.HUMAN_VERIFICATION_VENDOR_KEY,
        webhookSecret: env.HUMAN_VERIFICATION_WEBHOOK_SECRET,
        fetch: fetchImpl,
        ...(deps.subtle === undefined ? {} : { subtle: deps.subtle }),
        ...(now === undefined ? {} : { now }),
        ...deps.vendor,
      })
    }
    case HumanVerificationProviders.manual_review: {
      if (deps.manualReview === undefined) {
        throw new VerificationConfigError(
          kind,
          `HUMAN_VERIFICATION_PROVIDER=${kind} requires the identity review callbacks (createReview, getReviewStatus).`,
          env.APP_ENV,
        )
      }
      return new ManualReviewVerificationProvider({
        createReview: deps.manualReview.createReview,
        getReviewStatus: deps.manualReview.getReviewStatus,
        ...(now === undefined ? {} : { now }),
      })
    }
    default: {
      const exhaustive: never = kind
      throw new VerificationConfigError(
        String(exhaustive) as HumanVerificationProviderKind,
        `Unknown HUMAN_VERIFICATION_PROVIDER ${String(exhaustive)}`,
        env.APP_ENV,
      )
    }
  }
}

function defaultFetch(): FetchLike | undefined {
  const global = globalThis as { fetch?: unknown }
  if (typeof global.fetch !== 'function') return undefined
  // The global fetch accepts a superset of FetchRequestInit and returns a superset of
  // FetchResponseLike; the structural narrowing is the whole point of the injected type.
  const bound = (
    global.fetch as (url: string, init?: FetchRequestInitLike) => Promise<FetchResponseLike>
  ).bind(globalThis)
  return (url, init) => bound(url, init)
}

type FetchRequestInitLike = Parameters<FetchLike>[1]
type FetchResponseLike = Awaited<ReturnType<FetchLike>>
