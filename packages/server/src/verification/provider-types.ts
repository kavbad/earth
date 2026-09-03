/**
 * Structural copy of the `HumanVerificationProvider` contract of `@earth/auth`
 * (`packages/auth/src/verification/types.ts`; spec §15, §111; DB_API §1).
 *
 * `@earth/auth` is written concurrently and is not yet a resolvable dependency of this package,
 * so the server codes against these structurally identical types (same names, same fields, same
 * string values). Once `@earth/auth` is added to `packages/server/package.json`, this file can
 * become `export type { ... } from '@earth/auth'` plus re-exports of `failureKindForResult` /
 * `humanPassStatusForResult` without touching any handler.
 *
 * `VerificationResult.metadata` is the provider's private payload: it is written to
 * `private.human_pass_metadata` through `human_pass_record_result` and never sent to clients.
 */
import type { HumanVerificationProviderKind } from '@earth/config'
import type { HumanId, HumanPassRiskLevel, HumanPassStatus, PushPlatform } from '@earth/domain'
import { z } from 'zod'

/** How the client completes the verification step. */
export const VERIFICATION_MODES = ['hosted_url', 'native_sdk', 'manual_review', 'mock'] as const
export type VerificationMode = (typeof VERIFICATION_MODES)[number]
export const VerificationModeSchema = z.enum(VERIFICATION_MODES)
export const VerificationModes = VerificationModeSchema.enum

/** Normalized provider outcome (spec §15, §77, §111). */
export const VERIFICATION_STATUSES = [
  'verified',
  'review_required',
  'rejected',
  'pending',
  'inconclusive',
  'error',
] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]
export const VerificationStatusSchema = z.enum(VERIFICATION_STATUSES)
export const VerificationStatuses = VerificationStatusSchema.enum

/** Spec §111 failure copy selector: `technical` → Try again, `inconclusive` → Get help, `duplicate` → Recover. */
export const VERIFICATION_FAILURE_KINDS = ['technical', 'inconclusive', 'duplicate'] as const
export type VerificationFailureKind = (typeof VERIFICATION_FAILURE_KINDS)[number]
export const VerificationFailureKindSchema = z.enum(VERIFICATION_FAILURE_KINDS)
export const VerificationFailureKinds = VerificationFailureKindSchema.enum

/** Development-only outcome selector honoured by the mock provider and ignored by real ones. */
export const MOCK_VERIFICATION_OUTCOMES = [
  'verified',
  'duplicate',
  'inconclusive',
  'technical',
  'rejected',
] as const
export type MockVerificationOutcome = (typeof MOCK_VERIFICATION_OUTCOMES)[number]
export const MockVerificationOutcomeSchema = z.enum(MOCK_VERIFICATION_OUTCOMES)

export interface StartVerificationInput {
  readonly humanId: HumanId
  /** `human_passes.id` returned by `claim_verification_begin` (DB_API §1). */
  readonly humanPassId: string
  /** BCP 47 tag (`en-US`). */
  readonly locale: string
  readonly platform: PushPlatform
  /** Where a hosted flow sends the person back; absent for native SDK flows. */
  readonly returnUrl?: string
  /** Mock outcome selector (development only). */
  readonly hint?: MockVerificationOutcome
}

export interface VerificationSession {
  readonly sessionId: string
  readonly provider: HumanVerificationProviderKind
  readonly mode: VerificationMode
  /** Hosted step URL when `mode = 'hosted_url'`. */
  readonly url?: string | undefined
  /** ISO 8601. */
  readonly expiresAt: string
}

export interface VerificationResult {
  readonly status: VerificationStatus
  readonly riskLevel: HumanPassRiskLevel | null
  /** Stable provider-side identifier. */
  readonly providerReference: string
  /** The existing Human this person most likely is (spec §48). */
  readonly duplicateOfHumanId?: HumanId | null | undefined
  /** Private provider payload. Service-only; never sent to clients (spec §19). */
  readonly metadata: Readonly<Record<string, unknown>>
  /** Drives the spec §111 copy. Absent for `verified` and `pending`. */
  readonly failureKind?: VerificationFailureKind | undefined
}

/** A provider callback (vendor adapter) after signature verification. */
export interface VerificationWebhookEvent {
  readonly sessionId: string
  readonly result: VerificationResult
}

/** Spec §15 interface. `kind` names the adapter for logs and `human_passes.provider`. */
export interface HumanVerificationProvider {
  readonly kind: HumanVerificationProviderKind
  startVerification(input: StartVerificationInput): Promise<VerificationSession>
  getVerificationResult(sessionId: string): Promise<VerificationResult>
  /**
   * Authenticates and parses a provider callback. Throws `EarthError('forbidden')` on a bad
   * signature. Only adapters that receive callbacks implement it.
   */
  verifyWebhook?(rawBody: string, signatureHeader: string | null): Promise<VerificationWebhookEvent>
}

/**
 * The spec §111 failure kind of a result, or `null` when it is not a failure. Mirrors
 * `failureKindForResult` in `@earth/auth`.
 */
export function failureKindForResult(
  result: Pick<VerificationResult, 'status' | 'duplicateOfHumanId' | 'failureKind'>,
): VerificationFailureKind | null {
  if (result.failureKind !== undefined) return result.failureKind
  switch (result.status) {
    case 'verified':
    case 'pending':
      return null
    case 'error':
      return VerificationFailureKinds.technical
    case 'review_required':
      return result.duplicateOfHumanId
        ? VerificationFailureKinds.duplicate
        : VerificationFailureKinds.inconclusive
    case 'rejected':
    case 'inconclusive':
      return VerificationFailureKinds.inconclusive
    default: {
      const exhaustive: never = result.status
      throw new Error(`Unknown verification status: ${String(exhaustive)}`)
    }
  }
}

/**
 * `human_passes.status` to record for a result (`human_pass_record_result`, DB_API §1). Mirrors
 * `humanPassStatusForResult` in `@earth/auth`: `pending` keeps the pass `verifying`, a technical
 * `error` resets it to `unverified`, anything needing a person becomes `review_required`.
 */
export function humanPassStatusForResult(
  result: Pick<VerificationResult, 'status'>,
): HumanPassStatus {
  switch (result.status) {
    case 'verified':
      return 'verified'
    case 'rejected':
      return 'rejected'
    case 'review_required':
    case 'inconclusive':
      return 'review_required'
    case 'pending':
      return 'verifying'
    case 'error':
      return 'unverified'
    default: {
      const exhaustive: never = result.status
      throw new Error(`Unknown verification status: ${String(exhaustive)}`)
    }
  }
}
