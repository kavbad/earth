/**
 * HumanVerificationProvider — the external high-assurance boundary of spec §15.
 *
 * The application never runs face recognition itself; it starts a session with a provider,
 * reads back a normalized result, and records it through the service RPC
 * `human_pass_record_result` (DB_API §1). Three adapters implement this contract:
 * `MockHumanVerificationProvider` (development only), `ManualReviewVerificationProvider`
 * (spec §79 accessibility fallback) and `VendorHumanVerificationProvider` (hosted liveness).
 *
 * `VerificationResult.metadata` is the provider's private payload. It is written to
 * `private.human_pass_metadata` and is never sent to clients (spec §19, §78). The only
 * client-facing projection of a result is {@link toClientVerificationOutcome}.
 */
import {
  type AppEnv,
  AppEnvs,
  HUMAN_VERIFICATION_PROVIDERS,
  type HumanVerificationProviderKind,
} from '@earth/config'
import {
  HUMAN_PASS_RISK_LEVELS,
  type HumanPassRiskLevel,
  type HumanPassStatus,
  HumanPassStatusSchema,
  HumanIdSchema,
  IsoDateTimeSchema,
  PUSH_PLATFORMS,
  UrlSchema,
} from '@earth/domain'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Value lists
// ---------------------------------------------------------------------------

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

/** Object form of `HUMAN_PASS_STATUS` (`@earth/domain`) so comparisons never use string literals. */
export const HumanPassStatuses = HumanPassStatusSchema.enum

/**
 * Which spec §111 failure a result represents: `technical` → "Try again", `inconclusive` →
 * "Get help verifying", `duplicate` → "Recover your place". Never a generic failure.
 */
export const VERIFICATION_FAILURE_KINDS = ['technical', 'inconclusive', 'duplicate'] as const
export type VerificationFailureKind = (typeof VERIFICATION_FAILURE_KINDS)[number]
export const VerificationFailureKindSchema = z.enum(VERIFICATION_FAILURE_KINDS)
export const VerificationFailureKinds = VerificationFailureKindSchema.enum

/** The client platform starting a session; the same three values as `push_tokens.platform`. */
export const VERIFICATION_PLATFORMS = PUSH_PLATFORMS
export type VerificationPlatform = (typeof VERIFICATION_PLATFORMS)[number]
export const VerificationPlatformSchema = z.enum(VERIFICATION_PLATFORMS)

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
export const MockVerificationOutcomes = MockVerificationOutcomeSchema.enum

/**
 * The only `APP_ENV` values that may run the mock provider (spec §15: "Development may use a
 * mock provider"; ARCHITECTURE §14). The check is an allow-list, not `!== production`, so a
 * typo, an absent value or a hand-built environment object fails closed.
 */
export const MOCK_ALLOWED_APP_ENVS = [
  AppEnvs.development,
  AppEnvs.preview,
] as const satisfies readonly AppEnv[]
export type MockAllowedAppEnv = (typeof MOCK_ALLOWED_APP_ENVS)[number]

export function isMockAllowedAppEnv(appEnv: unknown): appEnv is MockAllowedAppEnv {
  return typeof appEnv === 'string' && (MOCK_ALLOWED_APP_ENVS as readonly string[]).includes(appEnv)
}

/** `identity_reviews.kind` (DB_API §1; spec §48, §79, §80). */
export const IDENTITY_REVIEW_KINDS = [
  'duplicate',
  'inconclusive',
  'help',
  'safety',
  'recovery',
] as const
export type IdentityReviewKind = (typeof IDENTITY_REVIEW_KINDS)[number]
export const IdentityReviewKindSchema = z.enum(IDENTITY_REVIEW_KINDS)
export const IdentityReviewKinds = IdentityReviewKindSchema.enum

/** `identity_reviews.status` (DB_API §1). */
export const IDENTITY_REVIEW_STATUSES = ['open', 'approved', 'rejected'] as const
export type IdentityReviewStatus = (typeof IDENTITY_REVIEW_STATUSES)[number]
export const IdentityReviewStatusSchema = z.enum(IDENTITY_REVIEW_STATUSES)
export const IdentityReviewStatuses = IdentityReviewStatusSchema.enum

// ---------------------------------------------------------------------------
// Session and result
// ---------------------------------------------------------------------------

export const StartVerificationInputSchema = z.object({
  humanId: HumanIdSchema,
  /** `human_passes.id` returned by `claim_verification_begin` (DB_API §1). */
  humanPassId: z.string().min(1),
  /** BCP 47 tag (`en-US`). */
  locale: z.string().min(2),
  platform: VerificationPlatformSchema,
  /** Where a hosted flow sends the person back; absent for native SDK flows. */
  returnUrl: UrlSchema.optional(),
  /** Mock outcome selector (development only). Real providers ignore it. */
  hint: MockVerificationOutcomeSchema.optional(),
})
export type StartVerificationInput = z.infer<typeof StartVerificationInputSchema>

export const VerificationSessionSchema = z.object({
  sessionId: z.string().min(1),
  provider: z.enum(HUMAN_VERIFICATION_PROVIDERS),
  mode: VerificationModeSchema,
  /** Hosted step URL when `mode = 'hosted_url'`. */
  url: UrlSchema.optional(),
  /** ISO 8601. */
  expiresAt: IsoDateTimeSchema,
})
export type VerificationSession = z.infer<typeof VerificationSessionSchema>

export const VerificationResultSchema = z.object({
  status: VerificationStatusSchema,
  riskLevel: z.enum(HUMAN_PASS_RISK_LEVELS).nullable(),
  /** Stable provider-side identifier (`human_passes.provider_reference`). */
  providerReference: z.string().min(1),
  /** The existing Human this person most likely is (spec §48). */
  duplicateOfHumanId: HumanIdSchema.nullable().optional(),
  /** Private provider payload. Service-only; never sent to clients (spec §19). */
  metadata: z.record(z.string(), z.unknown()),
  /** Drives the spec §111 copy. Absent for `verified` and `pending`. */
  failureKind: VerificationFailureKindSchema.optional(),
})
export type VerificationResult = z.infer<typeof VerificationResultSchema>

/**
 * Result fields that stay in the server tier (`private.human_pass_metadata`; spec §19, §78).
 * `duplicateOfHumanId` is a biometric match against another person and is as private as the
 * rest: the §48 screen does not need it.
 */
export const VERIFICATION_PRIVATE_RESULT_KEYS = [
  'metadata',
  'riskLevel',
  'providerReference',
  'duplicateOfHumanId',
] as const satisfies readonly (keyof VerificationResult)[]
export type VerificationPrivateResultKey = (typeof VERIFICATION_PRIVATE_RESULT_KEYS)[number]

/** The fields a result needs for the derivations below; any `VerificationResult` satisfies it. */
export type VerificationResultOutcome = Pick<VerificationResult, 'status'> &
  Partial<Pick<VerificationResult, 'duplicateOfHumanId' | 'failureKind'>>

/**
 * What a client may learn about a verification result (spec §111): the Human Pass status it
 * produced and the failure kind that picks the copy. Nothing else leaves the server tier.
 */
export interface ClientVerificationOutcome {
  readonly status: HumanPassStatus
  readonly failureKind: VerificationFailureKind | null
}
export const CLIENT_VERIFICATION_OUTCOME_KEYS = [
  'status',
  'failureKind',
] as const satisfies readonly (keyof ClientVerificationOutcome)[]

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

// ---------------------------------------------------------------------------
// Configuration errors
// ---------------------------------------------------------------------------

/** A provider was configured in a way the spec forbids (for example mock in production). */
export class VerificationConfigError extends Error {
  override readonly name = 'VerificationConfigError' as const
  readonly provider: HumanVerificationProviderKind
  readonly appEnv: AppEnv | undefined

  constructor(provider: HumanVerificationProviderKind, message: string, appEnv?: AppEnv) {
    super(message)
    this.provider = provider
    this.appEnv = appEnv
  }
}

// ---------------------------------------------------------------------------
// Derivations shared by adapters and the server tier
// ---------------------------------------------------------------------------

function namesDuplicate(result: VerificationResultOutcome): boolean {
  return typeof result.duplicateOfHumanId === 'string' && result.duplicateOfHumanId !== ''
}

/**
 * The spec §111 failure kind of a result, or `null` when it is not a failure (`verified`,
 * `pending`).
 *
 * A result that names an existing Human is a duplicate whatever its status says (spec §48,
 * §128: a liveness check that "passed" but matched another Human must never create a second
 * one). Otherwise an explicit `failureKind` wins; then `review_required`, `rejected` and
 * `inconclusive` need a person (spec §79: a failed automation never means the person is not
 * Human) and `error` is technical.
 */
export function failureKindForResult(
  result: VerificationResultOutcome,
): VerificationFailureKind | null {
  if (namesDuplicate(result)) return VerificationFailureKinds.duplicate
  if (result.failureKind !== undefined) return result.failureKind
  switch (result.status) {
    case 'verified':
    case 'pending':
      return null
    case 'error':
      return VerificationFailureKinds.technical
    case 'review_required':
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
 * `human_passes.status` to record for a result (`human_pass_record_result`, DB_API §1).
 * A duplicate is always `review_required` (the RPC opens the `duplicate` review from it);
 * `pending` keeps the pass `verifying`; a technical `error` resets it to `unverified` so the
 * person can simply try again; anything else needing a person becomes `review_required`.
 */
export function humanPassStatusForResult(result: VerificationResultOutcome): HumanPassStatus {
  if (failureKindForResult(result) === VerificationFailureKinds.duplicate) {
    return HumanPassStatuses.review_required
  }
  switch (result.status) {
    case 'verified':
      return HumanPassStatuses.verified
    case 'rejected':
      return HumanPassStatuses.rejected
    case 'review_required':
    case 'inconclusive':
      return HumanPassStatuses.review_required
    case 'pending':
      return HumanPassStatuses.verifying
    case 'error':
      return HumanPassStatuses.unverified
    default: {
      const exhaustive: never = result.status
      throw new Error(`Unknown verification status: ${String(exhaustive)}`)
    }
  }
}

/**
 * The client-facing projection of a provider result: exactly {@link CLIENT_VERIFICATION_OUTCOME_KEYS},
 * built field by field so no private key can ride along (spec §19, §78).
 */
export function toClientVerificationOutcome(
  result: VerificationResultOutcome,
): ClientVerificationOutcome {
  return { status: humanPassStatusForResult(result), failureKind: failureKindForResult(result) }
}

/**
 * The §111 failure kind implied by a Human Pass status alone — what a client can derive when
 * the server answers only `status` (`VerificationSessionDto`, `ClaimStateDto.verification`).
 * `review_required` reads as inconclusive unless the server also names a `duplicate` kind.
 */
export function failureKindForHumanPassStatus(
  status: HumanPassStatus,
): VerificationFailureKind | null {
  switch (status) {
    case 'unverified':
      return VerificationFailureKinds.technical
    case 'verifying':
    case 'verified':
      return null
    case 'review_required':
    case 'rejected':
      return VerificationFailureKinds.inconclusive
    default: {
      const exhaustive: never = status
      throw new Error(`Unknown human pass status: ${String(exhaustive)}`)
    }
  }
}

/** True when the provider is still working and the client should poll again. */
export function isVerificationPending(result: Pick<VerificationResult, 'status'>): boolean {
  return result.status === VerificationStatuses.pending
}

export function isRiskLevel(value: unknown): value is HumanPassRiskLevel {
  return typeof value === 'string' && (HUMAN_PASS_RISK_LEVELS as readonly string[]).includes(value)
}
