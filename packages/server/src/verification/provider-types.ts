/**
 * The `HumanVerificationProvider` contract of `@earth/auth` (`packages/auth/src/verification`;
 * spec §15, §111; DB_API §1), re-exported so handlers and tests keep one import path inside this
 * package.
 *
 * This file used to be a structural copy written while `@earth/auth` was not yet a resolvable
 * dependency. The workspace link exists now (`@earth/auth` in `package.json`, verified with node
 * resolution), so the copy is gone: the server uses the very `failureKindForResult` /
 * `humanPassStatusForResult` the adapters use — a result that names an existing Human is always a
 * duplicate and is always recorded `review_required` (spec §48, §128), exactly as
 * `human_pass_record_result` enforces — and a change to the contract fails this package's
 * typecheck instead of drifting silently.
 *
 * `VerificationResult.metadata` is the provider's private payload: it is written to
 * `private.human_pass_metadata` through `human_pass_record_result` and never sent to clients.
 */
export {
  MOCK_VERIFICATION_OUTCOMES,
  MockVerificationOutcomeSchema,
  MockVerificationOutcomes,
  VERIFICATION_FAILURE_KINDS,
  VERIFICATION_MODES,
  VERIFICATION_STATUSES,
  VerificationFailureKindSchema,
  VerificationFailureKinds,
  VerificationModeSchema,
  VerificationModes,
  VerificationStatusSchema,
  VerificationStatuses,
  failureKindForResult,
  humanPassStatusForResult,
  type HumanVerificationProvider,
  type MockVerificationOutcome,
  type StartVerificationInput,
  type VerificationFailureKind,
  type VerificationMode,
  type VerificationResult,
  type VerificationSession,
  type VerificationStatus,
  type VerificationWebhookEvent,
} from '@earth/auth'
