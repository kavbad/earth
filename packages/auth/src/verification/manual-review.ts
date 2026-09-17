/**
 * ManualReviewVerificationProvider — the spec §15/§79 fallback: a person reviews the claim.
 *
 * Starting a session creates an `identity_reviews` row through an injected callback; the
 * review id is the session id. Reading the result maps the review's status:
 * `approved → verified`, `rejected → rejected`, `open → pending`.
 *
 * The database is not touched here; the server tier injects callbacks that call
 * `identity_review_create` / read `identity_reviews` (DB_API §1).
 */
import { HumanVerificationProviders } from '@earth/config'
import { type HumanId } from '@earth/domain'

import {
  type HumanVerificationProvider,
  type IdentityReviewKind,
  IdentityReviewKinds,
  type IdentityReviewStatus,
  type StartVerificationInput,
  VerificationFailureKinds,
  VerificationModes,
  type VerificationResult,
  type VerificationSession,
  VerificationStatuses,
} from './types'

export const MANUAL_REVIEW_PROVIDER_REFERENCE_PREFIX = 'manual_review:' as const
/** A review case stays claimable for a week; the person is contacted by support. */
export const MANUAL_REVIEW_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** The two review kinds a verification session may open (spec §79 help / inconclusive). */
export type ManualReviewKind = Extract<IdentityReviewKind, 'help' | 'inconclusive'>

export interface CreateReviewInput {
  readonly humanId: HumanId
  readonly humanPassId: string
  readonly kind: ManualReviewKind
  readonly locale: string
  readonly platform: StartVerificationInput['platform']
}

export interface CreateReviewOutput {
  readonly reviewId: string
}

export interface ManualReviewVerificationProviderDeps {
  createReview(input: CreateReviewInput): Promise<CreateReviewOutput>
  /** `null` when no review has that id. */
  getReviewStatus(reviewId: string): Promise<IdentityReviewStatus | null>
  readonly now?: () => Date
  /** Review kind opened by `startVerification`. Defaults to `help`. */
  readonly reviewKind?: ManualReviewKind
  readonly sessionTtlMs?: number
}

export class ManualReviewVerificationProvider implements HumanVerificationProvider {
  readonly kind = HumanVerificationProviders.manual_review
  private readonly deps: ManualReviewVerificationProviderDeps
  private readonly now: () => Date
  private readonly reviewKind: ManualReviewKind
  private readonly sessionTtlMs: number

  constructor(deps: ManualReviewVerificationProviderDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => new Date())
    this.reviewKind = deps.reviewKind ?? IdentityReviewKinds.help
    this.sessionTtlMs = deps.sessionTtlMs ?? MANUAL_REVIEW_SESSION_TTL_MS
  }

  async startVerification(input: StartVerificationInput): Promise<VerificationSession> {
    const { reviewId } = await this.deps.createReview({
      humanId: input.humanId,
      humanPassId: input.humanPassId,
      kind: this.reviewKind,
      locale: input.locale,
      platform: input.platform,
    })
    return {
      sessionId: reviewId,
      provider: this.kind,
      mode: VerificationModes.manual_review,
      expiresAt: new Date(this.now().getTime() + this.sessionTtlMs).toISOString(),
    }
  }

  async getVerificationResult(sessionId: string): Promise<VerificationResult> {
    const status = await this.deps.getReviewStatus(sessionId)
    return manualReviewResultFor(sessionId, status)
  }
}

/** Maps a review status onto the normalized result; a missing review is a technical error. */
export function manualReviewResultFor(
  reviewId: string,
  status: IdentityReviewStatus | null,
): VerificationResult {
  const providerReference = `${MANUAL_REVIEW_PROVIDER_REFERENCE_PREFIX}${reviewId}`
  const metadata = {
    provider: HumanVerificationProviders.manual_review,
    reviewId,
    reviewStatus: status,
  }
  switch (status) {
    case 'approved':
      // A person approved the claim; no automated risk score exists.
      return {
        status: VerificationStatuses.verified,
        riskLevel: null,
        providerReference,
        duplicateOfHumanId: null,
        metadata,
      }
    case 'rejected':
      return {
        status: VerificationStatuses.rejected,
        riskLevel: null,
        providerReference,
        duplicateOfHumanId: null,
        metadata,
        failureKind: VerificationFailureKinds.inconclusive,
      }
    case 'open':
      return {
        status: VerificationStatuses.pending,
        riskLevel: null,
        providerReference,
        duplicateOfHumanId: null,
        metadata,
      }
    case null:
      return {
        status: VerificationStatuses.error,
        riskLevel: null,
        providerReference,
        duplicateOfHumanId: null,
        metadata: { ...metadata, reason: 'review_not_found' },
        failureKind: VerificationFailureKinds.technical,
      }
    default: {
      const exhaustive: never = status
      throw new Error(`Unknown review status: ${String(exhaustive)}`)
    }
  }
}
