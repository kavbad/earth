import { describe, expect, it } from 'vitest'

import { type AppEnv } from '@earth/config'

import { ManualReviewVerificationProvider } from './manual-review'
import { MockHumanVerificationProvider } from './mock'
import {
  type VerificationProviderDeps,
  type VerificationProviderEnv,
  createVerificationProvider,
} from './registry'
import { VerificationConfigError } from './types'
import { type FetchLike, VendorHumanVerificationProvider } from './vendor'

const fetch: FetchLike = async () => ({ ok: true, status: 200, text: async () => '{}' })

const manualReview: NonNullable<VerificationProviderDeps['manualReview']> = {
  createReview: async () => ({ reviewId: 'r1' }),
  getReviewStatus: async () => 'open',
}

function env(overrides: Partial<VerificationProviderEnv>): VerificationProviderEnv {
  return { HUMAN_VERIFICATION_PROVIDER: 'mock', APP_ENV: 'development', ...overrides }
}

describe('createVerificationProvider', () => {
  it('builds the mock provider outside production', () => {
    const provider = createVerificationProvider(env({}), { mock: { defaultOutcome: 'technical' } })
    expect(provider).toBeInstanceOf(MockHumanVerificationProvider)
    expect(provider.kind).toBe('mock')
    expect(createVerificationProvider(env({ APP_ENV: 'preview' }))).toBeInstanceOf(
      MockHumanVerificationProvider,
    )
  })

  it('never hands production the mock provider', () => {
    expect(() => createVerificationProvider(env({ APP_ENV: 'production' }))).toThrow(
      VerificationConfigError,
    )
    try {
      createVerificationProvider(env({ APP_ENV: 'production' }))
    } catch (error) {
      expect(error).toBeInstanceOf(VerificationConfigError)
      expect((error as VerificationConfigError).provider).toBe('mock')
      expect((error as VerificationConfigError).appEnv).toBe('production')
    }
  })

  it('fails closed on an environment that is not explicitly development or preview', () => {
    for (const bad of ['prod', 'PRODUCTION', 'Production', 'staging', '', undefined]) {
      const APP_ENV = bad as unknown as AppEnv
      expect(() => createVerificationProvider(env({ APP_ENV }))).toThrow(VerificationConfigError)
    }
    // A hand-built env object without APP_ENV at all.
    expect(() =>
      createVerificationProvider({
        HUMAN_VERIFICATION_PROVIDER: 'mock',
      } as unknown as VerificationProviderEnv),
    ).toThrow(VerificationConfigError)
  })

  it('cannot be talked into the mock through the mock tuning deps', () => {
    // `deps.mock` is typed without `appEnv`, but it is a runtime object: it must not override
    // the environment that was checked.
    const smuggled = { appEnv: 'development' } as unknown as NonNullable<
      VerificationProviderDeps['mock']
    >
    expect(() =>
      createVerificationProvider(env({ APP_ENV: 'production' }), { mock: smuggled }),
    ).toThrow(VerificationConfigError)
    const reverse = { appEnv: 'production' } as unknown as NonNullable<
      VerificationProviderDeps['mock']
    >
    expect(createVerificationProvider(env({}), { mock: reverse })).toBeInstanceOf(
      MockHumanVerificationProvider,
    )
  })

  it('refuses an unknown provider kind instead of picking a default', () => {
    expect(() =>
      createVerificationProvider(
        env({
          HUMAN_VERIFICATION_PROVIDER:
            'none' as VerificationProviderEnv['HUMAN_VERIFICATION_PROVIDER'],
        }),
      ),
    ).toThrow(VerificationConfigError)
  })

  it('requires url and key for the vendor provider', () => {
    const vendor = env({ HUMAN_VERIFICATION_PROVIDER: 'vendor', APP_ENV: 'production' })
    expect(() => createVerificationProvider(vendor, { fetch })).toThrow(VerificationConfigError)
    expect(() =>
      createVerificationProvider(
        { ...vendor, HUMAN_VERIFICATION_VENDOR_URL: 'https://v.example' },
        { fetch },
      ),
    ).toThrow(VerificationConfigError)
    expect(() =>
      createVerificationProvider({ ...vendor, HUMAN_VERIFICATION_VENDOR_KEY: 'k' }, { fetch }),
    ).toThrow(VerificationConfigError)
    expect(() =>
      createVerificationProvider(
        { ...vendor, HUMAN_VERIFICATION_VENDOR_URL: '  ', HUMAN_VERIFICATION_VENDOR_KEY: 'k' },
        { fetch },
      ),
    ).toThrow(VerificationConfigError)

    const provider = createVerificationProvider(
      {
        ...vendor,
        HUMAN_VERIFICATION_VENDOR_URL: 'https://v.example',
        HUMAN_VERIFICATION_VENDOR_KEY: 'k',
        HUMAN_VERIFICATION_WEBHOOK_SECRET: 's',
      },
      { fetch, vendor: { signatureHeaderName: 'x-vendor-sig' } },
    )
    expect(provider).toBeInstanceOf(VendorHumanVerificationProvider)
    expect(provider.kind).toBe('vendor')
    expect((provider as VendorHumanVerificationProvider).signatureHeaderName).toBe('x-vendor-sig')
    expect(typeof provider.verifyWebhook).toBe('function')
  })

  it('uses the global fetch for the vendor when none is injected', () => {
    const provider = createVerificationProvider(
      env({
        HUMAN_VERIFICATION_PROVIDER: 'vendor',
        HUMAN_VERIFICATION_VENDOR_URL: 'https://v.example',
        HUMAN_VERIFICATION_VENDOR_KEY: 'k',
      }),
    )
    expect(provider).toBeInstanceOf(VendorHumanVerificationProvider)
  })

  it('builds the manual review provider from the review callbacks', () => {
    const manual = env({ HUMAN_VERIFICATION_PROVIDER: 'manual_review', APP_ENV: 'production' })
    expect(() => createVerificationProvider(manual)).toThrow(VerificationConfigError)
    const provider = createVerificationProvider(manual, { manualReview })
    expect(provider).toBeInstanceOf(ManualReviewVerificationProvider)
    expect(provider.kind).toBe('manual_review')
    expect(provider.verifyWebhook).toBeUndefined()
  })
})
