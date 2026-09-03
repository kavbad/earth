import { VerificationConfigError } from '@earth/auth'
import { type ServerEnv, loadServerEnv } from '@earth/config'
import { EarthError, type HumanId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { createFakeSupabase, testEnvSource } from './fakes'
import {
  IDENTITY_REVIEWS_TABLE,
  createIdentityReviewCallbacks,
  createVerificationProviderFromEnv,
} from './verification'

const HUMAN_ID = '11111111-1111-4111-8111-111111111111' as HumanId

function env(overrides: Record<string, string> = {}): ServerEnv {
  return loadServerEnv(testEnvSource(overrides))
}

function adminClient(fake = createFakeSupabase()) {
  return {
    fake,
    client: fake.factory('http://localhost:54321', 'service-role-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { headers: {} },
    }),
  }
}

describe('createIdentityReviewCallbacks', () => {
  it('opens a review row and returns its id', async () => {
    const { fake, client } = adminClient()
    const callbacks = createIdentityReviewCallbacks(client)
    const out = await callbacks.createReview({
      humanId: HUMAN_ID,
      humanPassId: 'pass-1',
      kind: 'help',
      locale: 'en-US',
      platform: 'web',
    })
    expect(out).toEqual({ reviewId: 'review-1' })
    expect(fake.reviews).toEqual([
      {
        id: 'review-1',
        human_id: HUMAN_ID,
        kind: 'help',
        status: 'open',
        details: { humanPassId: 'pass-1', locale: 'en-US', platform: 'web' },
      },
    ])
  })

  it('reads the review status back and answers null for an unknown id', async () => {
    const { fake, client } = adminClient()
    const callbacks = createIdentityReviewCallbacks(client)
    const { reviewId } = await callbacks.createReview({
      humanId: HUMAN_ID,
      humanPassId: 'pass-1',
      kind: 'inconclusive',
      locale: 'en-US',
      platform: 'ios',
    })
    await expect(callbacks.getReviewStatus(reviewId)).resolves.toBe('open')
    fake.setReviewStatus(reviewId, 'approved')
    await expect(callbacks.getReviewStatus(reviewId)).resolves.toBe('approved')
    await expect(callbacks.getReviewStatus('review-404')).resolves.toBeNull()
  })

  it('turns table failures into internal EarthErrors without leaking the message', async () => {
    const { fake, client } = adminClient()
    fake.tableError = 'permission denied for table identity_reviews'
    const callbacks = createIdentityReviewCallbacks(client)
    await expect(
      callbacks.createReview({
        humanId: HUMAN_ID,
        humanPassId: 'pass-1',
        kind: 'help',
        locale: 'en-US',
        platform: 'web',
      }),
    ).rejects.toMatchObject({
      code: 'internal',
      details: { what: `${IDENTITY_REVIEWS_TABLE} insert` },
    })
    await expect(callbacks.getReviewStatus('review-1')).rejects.toBeInstanceOf(EarthError)
  })
})

describe('createVerificationProviderFromEnv', () => {
  it('builds the mock provider in development', () => {
    const { client } = adminClient()
    const provider = createVerificationProviderFromEnv(env(), { supabaseAdmin: client })
    expect(provider.kind).toBe('mock')
  })

  it('builds the manual-review provider over identity_reviews', async () => {
    const { fake, client } = adminClient()
    const provider = createVerificationProviderFromEnv(
      env({ HUMAN_VERIFICATION_PROVIDER: 'manual_review' }),
      { supabaseAdmin: client, now: () => new Date('2026-09-03T12:00:00.000Z') },
    )
    expect(provider.kind).toBe('manual_review')
    const session = await provider.startVerification({
      humanId: HUMAN_ID,
      humanPassId: 'pass-1',
      locale: 'en-US',
      platform: 'web',
    })
    expect(session.sessionId).toBe('review-1')
    expect(fake.reviews[0]?.kind).toBe('help')
    const pending = await provider.getVerificationResult(session.sessionId)
    expect(pending.status).toBe('pending')
  })

  it('refuses the mock provider in production', () => {
    const { client } = adminClient()
    const production: ServerEnv = { ...env(), APP_ENV: 'production' }
    expect(() => createVerificationProviderFromEnv(production, { supabaseAdmin: client })).toThrow(
      VerificationConfigError,
    )
  })
})
