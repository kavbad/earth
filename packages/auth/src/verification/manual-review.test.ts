import { describe, expect, it } from 'vitest'

import { type HumanId } from '@earth/domain'

import {
  type CreateReviewInput,
  MANUAL_REVIEW_PROVIDER_REFERENCE_PREFIX,
  ManualReviewVerificationProvider,
  manualReviewResultFor,
} from './manual-review'
import {
  type IdentityReviewStatus,
  type StartVerificationInput,
  VerificationResultSchema,
  VerificationSessionSchema,
} from './types'

const HUMAN = '11111111-1111-4111-8111-111111111111' as HumanId

const INPUT: StartVerificationInput = {
  humanId: HUMAN,
  humanPassId: 'pass-9',
  locale: 'fr-FR',
  platform: 'web',
}

function fakeReviews(initial: Record<string, IdentityReviewStatus> = {}) {
  const reviews = new Map<string, IdentityReviewStatus>(Object.entries(initial))
  const created: CreateReviewInput[] = []
  let n = 0
  return {
    reviews,
    created,
    createReview: async (input: CreateReviewInput) => {
      created.push(input)
      const reviewId = `review-${(n += 1)}`
      reviews.set(reviewId, 'open')
      return { reviewId }
    },
    getReviewStatus: async (reviewId: string) => reviews.get(reviewId) ?? null,
  }
}

describe('ManualReviewVerificationProvider', () => {
  it('opens a help review and returns a manual_review session whose id is the review id', async () => {
    const reviews = fakeReviews()
    const now = () => new Date('2026-09-03T10:00:00.000Z')
    const provider = new ManualReviewVerificationProvider({ ...reviews, now })

    const session = await provider.startVerification(INPUT)
    expect(VerificationSessionSchema.parse(session)).toEqual(session)
    expect(session).toEqual({
      sessionId: 'review-1',
      provider: 'manual_review',
      mode: 'manual_review',
      expiresAt: '2026-09-10T10:00:00.000Z',
    })
    expect(reviews.created).toEqual([
      { humanId: HUMAN, humanPassId: 'pass-9', kind: 'help', locale: 'fr-FR', platform: 'web' },
    ])
  })

  it('can open an inconclusive review instead', async () => {
    const reviews = fakeReviews()
    const provider = new ManualReviewVerificationProvider({
      ...reviews,
      reviewKind: 'inconclusive',
    })
    await provider.startVerification(INPUT)
    expect(reviews.created[0]?.kind).toBe('inconclusive')
  })

  it('maps open → pending, approved → verified, rejected → rejected', async () => {
    const reviews = fakeReviews()
    const provider = new ManualReviewVerificationProvider(reviews)
    const { sessionId } = await provider.startVerification(INPUT)

    const pending = await provider.getVerificationResult(sessionId)
    expect(pending.status).toBe('pending')
    expect(pending.failureKind).toBeUndefined()

    reviews.reviews.set(sessionId, 'approved')
    const verified = await provider.getVerificationResult(sessionId)
    expect(VerificationResultSchema.parse(verified)).toEqual(verified)
    expect(verified).toMatchObject({
      status: 'verified',
      riskLevel: null,
      providerReference: `${MANUAL_REVIEW_PROVIDER_REFERENCE_PREFIX}${sessionId}`,
      duplicateOfHumanId: null,
      metadata: { provider: 'manual_review', reviewId: sessionId, reviewStatus: 'approved' },
    })
    expect(verified.failureKind).toBeUndefined()

    reviews.reviews.set(sessionId, 'rejected')
    const rejected = await provider.getVerificationResult(sessionId)
    expect(rejected.status).toBe('rejected')
    // Spec §79: a rejection offers help, never "Verification failed".
    expect(rejected.failureKind).toBe('inconclusive')
  })

  it('treats an unknown review as a technical failure rather than throwing', async () => {
    const provider = new ManualReviewVerificationProvider(fakeReviews())
    const result = await provider.getVerificationResult('missing')
    expect(result.status).toBe('error')
    expect(result.failureKind).toBe('technical')
    expect(result.metadata).toMatchObject({ reason: 'review_not_found' })
  })

  it('manualReviewResultFor is schema-valid for every status', () => {
    for (const status of ['open', 'approved', 'rejected', null] as const) {
      const result = manualReviewResultFor('r', status)
      expect(VerificationResultSchema.safeParse(result).success).toBe(true)
    }
  })
})
