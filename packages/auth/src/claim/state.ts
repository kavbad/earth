/**
 * Client-side claim flow state machine (spec §44–§49, §79, §111).
 *
 * Pure: `nextStep(state, event)` returns a new state or the same reference when the event is
 * not allowed at the current step. The database owns the claim itself (`claim_start`,
 * `claim_set_identity`, `claim_verification_begin`, `claim_complete` — DB_API §1); this machine
 * only sequences screens and picks the copy for each verification failure.
 *
 * Steps, in the spec's order: `gate` (§44) → `group_label` (§45 step 2, start-group only) →
 * `credential` (§45 step 4) → `identity` (step 5) → `human_pass` (step 6) → `verifying` (step 7)
 * → `complete` (step 8: `claim_complete()` creates the Human, group, membership and conversation
 * in one transaction) → `done` (step 9: "You're on Earth", §49, then the group / chat).
 * "You're on Earth" is only ever shown at `done`, after the transaction succeeded. Failures branch
 * to `duplicate` (§48) or back to `human_pass` with the §111 copy; `help` is the review/recovery
 * exit (§48 actions, §79, §80) and continues to `complete` once a review is approved.
 *
 * What the client learns about a verification attempt is a {@link ClaimVerificationOutcome}:
 * the Human Pass status the server answers with and, when it says so, the §111 failure kind.
 * Provider metadata, risk level, provider reference and the matched Human never enter this
 * state (spec §19, §78) — `applyResult` copies exactly two fields.
 *
 * Copy is referenced by key into `@earth/ui`'s `copy` object, never by string, so a wording
 * change there flows through both clients.
 */
import { FeatureFlag, type FeatureFlagKey } from '@earth/config'
import {
  type ClaimCompleteDto,
  type ClaimIntent,
  ClaimIntentSchema,
  type EarthErrorCode,
  type HumanPassStatus,
} from '@earth/domain'
import { copy } from '@earth/ui'
import { z } from 'zod'

import {
  HumanPassStatuses,
  type IdentityReviewKind,
  IdentityReviewKinds,
  type IdentityReviewStatus,
  VERIFICATION_STATUSES,
  type VerificationFailureKind,
  VerificationFailureKinds,
  type VerificationStatus,
  failureKindForHumanPassStatus,
  failureKindForResult,
  humanPassStatusForResult,
} from '../verification/types'

// ---------------------------------------------------------------------------
// Steps, events, copy keys
// ---------------------------------------------------------------------------

export const CLAIM_STEPS = [
  'gate',
  'group_label',
  'credential',
  'identity',
  'human_pass',
  'verifying',
  'duplicate',
  'help',
  'complete',
  'done',
] as const
export type ClaimStep = (typeof CLAIM_STEPS)[number]
export const ClaimStepSchema = z.enum(CLAIM_STEPS)
export const ClaimSteps = ClaimStepSchema.enum

export type CopyKey = keyof typeof copy

/** Spec §111: each failure kind has its own action; there is no generic "Verification failed". */
export const CLAIM_FAILURE_COPY_KEYS = {
  technical: 'tryAgain',
  inconclusive: 'getHelpVerifying',
  duplicate: 'recoverYourPlace',
} as const satisfies Record<VerificationFailureKind, CopyKey>
export type ClaimFailureCopyKey = (typeof CLAIM_FAILURE_COPY_KEYS)[VerificationFailureKind]

/** Spec §48 title shown on the `duplicate` step. */
export const DUPLICATE_TITLE_COPY_KEY = 'alreadyOnEarth' as const satisfies CopyKey

export const DUPLICATE_ACTION_EVENTS = ['recover', 'notMe', 'needHelp', 'safety'] as const
export type DuplicateActionEvent = (typeof DUPLICATE_ACTION_EVENTS)[number]

/** Spec §48 actions in display order, each bound to the event it raises and its copy key. */
export const DUPLICATE_ACTIONS: ReadonlyArray<{
  readonly event: DuplicateActionEvent
  readonly copyKey: CopyKey
  readonly reviewKind: IdentityReviewKind
}> = [
  { event: 'recover', copyKey: 'recoverMyPlace', reviewKind: IdentityReviewKinds.recovery },
  { event: 'notMe', copyKey: 'thisIsntMe', reviewKind: IdentityReviewKinds.duplicate },
  { event: 'needHelp', copyKey: 'iNeedHelp', reviewKind: IdentityReviewKinds.help },
  { event: 'safety', copyKey: 'safetyIssue', reviewKind: IdentityReviewKinds.safety },
]

/**
 * Review kinds whose approval lets the claim continue to `complete` (DB_API §1: `claim_complete`
 * accepts an approved `identity_reviews` row). Recovery restores the *existing* Human (spec §80)
 * and a safety case is handled out of band, so neither resumes this flow.
 */
export const REVIEW_RESUMABLE_HELP_KINDS = [
  IdentityReviewKinds.help,
  IdentityReviewKinds.inconclusive,
  IdentityReviewKinds.duplicate,
] as const satisfies readonly IdentityReviewKind[]

/**
 * Title copy per step where the spec fixes one. `credential` depends on the intent; `complete`
 * (the transaction in flight) has none, and "You're on Earth" belongs to `done` (spec §45
 * step 8 before step 9; §49 needs the group the transaction returns).
 */
export const CLAIM_STEP_TITLE_COPY_KEYS = {
  gate: 'claimGate',
  group_label: 'optionalGroupName',
  credential: null,
  identity: null,
  human_pass: 'proveHuman',
  verifying: 'proveHuman',
  duplicate: DUPLICATE_TITLE_COPY_KEY,
  help: 'getHelpVerifying',
  complete: null,
  done: 'youreOnEarth',
} as const satisfies Record<ClaimStep, CopyKey | null>

/** The flag this machine reads (spec §44: the gate is removable without an app rewrite). */
export const CLAIM_FLAG_KEY = FeatureFlag.GROUP_ANCHORED_CLAIM_REQUIRED satisfies FeatureFlagKey

export type ClaimFlags = Readonly<Record<typeof CLAIM_FLAG_KEY, boolean>>

/**
 * What the client learns about a verification attempt. `status` is the Human Pass status the
 * server answers with (`VerificationSessionDto.status`, `ClaimStateDto.verification.status`);
 * provider statuses are accepted too so a raw adapter result can be fed in on the server side.
 * `failureKind`, when the server includes it, decides the §111 copy; otherwise it is derived
 * from the status. Only these two fields are ever read.
 */
export interface ClaimVerificationOutcome {
  readonly status: HumanPassStatus | VerificationStatus
  readonly failureKind?: VerificationFailureKind | null | undefined
}

export interface NormalizedClaimVerificationOutcome {
  readonly status: HumanPassStatus
  readonly failureKind: VerificationFailureKind | null
}

export interface ClaimFailure {
  readonly kind: VerificationFailureKind
  readonly copyKey: ClaimFailureCopyKey
  /** The Human Pass status the failure came with. */
  readonly status: HumanPassStatus
}

export interface ClaimVerificationState {
  readonly sessionId: string | null
  readonly status: HumanPassStatus | null
  /** How many results were received; the UI can back off polling with it. */
  readonly attempts: number
}

export interface ClaimFlowState {
  readonly step: ClaimStep
  readonly flags: ClaimFlags
  readonly intent: ClaimIntent | null
  readonly groupLabel: string | null
  readonly inviteToken: string | null
  readonly authenticated: boolean
  readonly identitySet: boolean
  readonly verification: ClaimVerificationState
  /** The failure that brought the person back to `human_pass` or on to `duplicate`. */
  readonly failure: ClaimFailure | null
  /** Which review/recovery case the `help` step opens. */
  readonly helpKind: IdentityReviewKind | null
  readonly completion: ClaimCompleteDto | null
}

export type ClaimEvent =
  | { readonly type: 'chooseStart' }
  | { readonly type: 'chooseJoin'; readonly inviteToken: string }
  /** Only allowed when `GROUP_ANCHORED_CLAIM_REQUIRED` is off (spec §44). */
  | { readonly type: 'continueWithoutGroup' }
  | { readonly type: 'labelSet'; readonly label: string | null }
  | { readonly type: 'authenticated' }
  | { readonly type: 'identitySet' }
  /** A session started (or restarted while one was pending). */
  | { readonly type: 'verificationStarted'; readonly sessionId: string }
  | { readonly type: 'verificationResult'; readonly result: ClaimVerificationOutcome }
  /** `claim_complete()` succeeded (spec §45 step 8 / §46 steps 6–7). */
  | { readonly type: 'completed'; readonly completion: ClaimCompleteDto }
  /** `claim_complete()` raised one of its codes (DB_API §1) or failed to reach the server. */
  | { readonly type: 'completeFailed'; readonly code: EarthErrorCode }
  /** The review opened from `help` was resolved (`identity_reviews.status`). */
  | { readonly type: 'reviewResolved'; readonly status: IdentityReviewStatus }
  | { readonly type: 'recover' }
  | { readonly type: 'notMe' }
  | { readonly type: 'needHelp' }
  | { readonly type: 'safety' }

export type ClaimEventType = ClaimEvent['type']

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

/** Server-side verification state to resume from (`ClaimStateDto.verification` satisfies it). */
export interface ClaimResumeVerification {
  readonly status: HumanPassStatus
  readonly sessionId?: string | null | undefined
  readonly failureKind?: VerificationFailureKind | null | undefined
}

export interface InitialClaimStateOptions {
  readonly flags: ClaimFlags
  /** A person arriving through a group link (spec §46) skips the gate. */
  readonly inviteToken?: string | null
  /** Resume support: a claim already started server-side (`claim_get`). */
  readonly intent?: ClaimIntent | null
  readonly groupLabel?: string | null
  readonly authenticated?: boolean
  readonly identitySet?: boolean
  /** Resume support: the Human Pass state (`claim_get().verification`). Only read once the identity is set. */
  readonly verification?: ClaimResumeVerification | null
}

const EMPTY_VERIFICATION: ClaimVerificationState = {
  sessionId: null,
  status: null,
  attempts: 0,
}

export function initialClaimState(options: InitialClaimStateOptions): ClaimFlowState {
  const inviteToken = options.inviteToken ?? null
  const intent = options.intent ?? (inviteToken === null ? null : ClaimIntentSchema.enum.join_group)
  const identitySet = options.identitySet ?? false
  // An identity can only have been set by an authenticated credential (spec §45 steps 4–5).
  const authenticated = (options.authenticated ?? false) || identitySet
  const base: ClaimFlowState = {
    step: resumeStep({ flags: options.flags, intent, authenticated, identitySet }),
    flags: options.flags,
    intent,
    groupLabel: options.groupLabel ?? null,
    inviteToken,
    authenticated,
    identitySet,
    verification: EMPTY_VERIFICATION,
    failure: null,
    helpKind: null,
    completion: null,
  }
  const verification = options.verification ?? null
  return verification === null || base.step !== ClaimSteps.human_pass
    ? base
    : resumeVerification(base, verification)
}

function resumeStep(input: {
  flags: ClaimFlags
  intent: ClaimIntent | null
  authenticated: boolean
  identitySet: boolean
}): ClaimStep {
  if (input.identitySet) return ClaimSteps.human_pass
  if (input.authenticated) return ClaimSteps.identity
  if (input.intent !== null) return ClaimSteps.credential
  return input.flags[CLAIM_FLAG_KEY] ? ClaimSteps.gate : ClaimSteps.credential
}

/** Places a resumed claim at the step its Human Pass status implies (never before `human_pass`). */
function resumeVerification(
  state: ClaimFlowState,
  resume: ClaimResumeVerification,
): ClaimFlowState {
  const sessionId = resume.sessionId ?? null
  const verification: ClaimVerificationState = { sessionId, status: resume.status, attempts: 0 }
  switch (resume.status) {
    case 'verified':
      return { ...state, step: ClaimSteps.complete, verification }
    case 'verifying':
      return sessionId === null
        ? { ...state, verification }
        : { ...state, step: ClaimSteps.verifying, verification }
    case 'unverified':
      return { ...state, verification }
    case 'review_required':
    case 'rejected': {
      const kind = resume.failureKind ?? failureKindForHumanPassStatus(resume.status)
      return kind === null
        ? { ...state, verification }
        : withFailure({ ...state, verification }, kind, resume.status)
    }
    default: {
      const exhaustive: never = resume.status
      throw new Error(`Unknown human pass status: ${String(exhaustive)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Returns the same reference when `event` is not allowed at `state.step`. */
export function nextStep(state: ClaimFlowState, event: ClaimEvent): ClaimFlowState {
  switch (state.step) {
    case 'gate':
      return atGate(state, event)
    case 'group_label':
      return event.type === 'labelSet'
        ? { ...state, step: ClaimSteps.credential, groupLabel: normalizeLabel(event.label) }
        : state
    case 'credential':
      return event.type === 'authenticated'
        ? { ...state, step: ClaimSteps.identity, authenticated: true }
        : state
    case 'identity':
      return event.type === 'identitySet'
        ? { ...state, step: ClaimSteps.human_pass, identitySet: true }
        : state
    case 'human_pass':
      return atHumanPass(state, event)
    case 'verifying':
      return atVerifying(state, event)
    case 'duplicate':
      return atDuplicate(state, event)
    case 'help':
      return atHelp(state, event)
    case 'complete':
      return atComplete(state, event)
    case 'done':
      return state
    default: {
      const exhaustive: never = state.step
      throw new Error(`Unknown claim step: ${String(exhaustive)}`)
    }
  }
}

function atGate(state: ClaimFlowState, event: ClaimEvent): ClaimFlowState {
  switch (event.type) {
    case 'chooseStart':
      return { ...state, step: ClaimSteps.group_label, intent: ClaimIntentSchema.enum.start_group }
    case 'chooseJoin':
      return {
        ...state,
        step: ClaimSteps.credential,
        intent: ClaimIntentSchema.enum.join_group,
        inviteToken: event.inviteToken,
      }
    case 'continueWithoutGroup':
      // Spec §44: not offered while the launch gate is on. The reducer refuses it too, so a
      // stale client cannot bypass the flag.
      return state.flags[CLAIM_FLAG_KEY] ? state : { ...state, step: ClaimSteps.credential }
    default:
      return state
  }
}

function startVerification(state: ClaimFlowState, sessionId: string): ClaimFlowState {
  return {
    ...state,
    step: ClaimSteps.verifying,
    failure: null,
    verification: { ...state.verification, sessionId, status: HumanPassStatuses.verifying },
  }
}

function atHumanPass(state: ClaimFlowState, event: ClaimEvent): ClaimFlowState {
  switch (event.type) {
    case 'verificationStarted':
      return startVerification(state, event.sessionId)
    case 'needHelp':
      // Spec §79 "Get help verifying" after an inconclusive automation.
      return { ...state, step: ClaimSteps.help, helpKind: IdentityReviewKinds.inconclusive }
    default:
      return state
  }
}

function atVerifying(state: ClaimFlowState, event: ClaimEvent): ClaimFlowState {
  switch (event.type) {
    case 'verificationResult':
      return applyResult(state, event.result)
    case 'verificationStarted':
      // A new session supersedes a pending one (the person tried again, spec §111).
      return startVerification(state, event.sessionId)
    default:
      return state
  }
}

function atDuplicate(state: ClaimFlowState, event: ClaimEvent): ClaimFlowState {
  const action = DUPLICATE_ACTIONS.find((candidate) => candidate.event === event.type)
  return action === undefined
    ? state
    : { ...state, step: ClaimSteps.help, helpKind: action.reviewKind }
}

function atHelp(state: ClaimFlowState, event: ClaimEvent): ClaimFlowState {
  if (event.type !== 'reviewResolved') return state
  if (
    state.helpKind === null ||
    !(REVIEW_RESUMABLE_HELP_KINDS as readonly IdentityReviewKind[]).includes(state.helpKind)
  ) {
    return state
  }
  switch (event.status) {
    case 'approved':
      // A person approved the claim; `claim_complete()` accepts the approved review (DB_API §1).
      return { ...state, step: ClaimSteps.complete, failure: null }
    case 'rejected':
      // Spec §79: a rejection still offers help, never "Verification failed".
      return withFailure(
        {
          ...state,
          verification: { ...state.verification, status: HumanPassStatuses.rejected },
        },
        VerificationFailureKinds.inconclusive,
        HumanPassStatuses.rejected,
      )
    case 'open':
      return state
    default: {
      const exhaustive: never = event.status
      throw new Error(`Unknown review status: ${String(exhaustive)}`)
    }
  }
}

function atComplete(state: ClaimFlowState, event: ClaimEvent): ClaimFlowState {
  switch (event.type) {
    case 'completed':
      return { ...state, step: ClaimSteps.done, completion: event.completion, failure: null }
    case 'completeFailed':
      return applyCompleteFailure(state, event.code)
    default:
      return state
  }
}

/**
 * `claim_complete()` failed (DB_API §1). `duplicate_human` is the §48 screen — the database
 * refused a second Human and the client never gets to `done`. A missing identity goes back to
 * that step; a pass that is not (yet) verified goes back to `human_pass` with the §111 copy:
 * `verification_pending` (a review is open) → "Get help verifying", anything else → "Try again".
 * For `claim_not_pending` the client should re-read `claim_get()` and re-initialise.
 */
function applyCompleteFailure(state: ClaimFlowState, code: EarthErrorCode): ClaimFlowState {
  switch (code) {
    case 'duplicate_human':
      return withFailure(
        state,
        VerificationFailureKinds.duplicate,
        state.verification.status ?? HumanPassStatuses.review_required,
      )
    case 'claim_identity_missing':
      return { ...state, step: ClaimSteps.identity, identitySet: false, failure: null }
    case 'verification_pending':
      return withFailure(
        state,
        VerificationFailureKinds.inconclusive,
        state.verification.status ?? HumanPassStatuses.review_required,
      )
    case 'verification_required':
      return withFailure(
        { ...state, verification: { ...state.verification, status: HumanPassStatuses.unverified } },
        VerificationFailureKinds.technical,
        HumanPassStatuses.unverified,
      )
    default:
      return withFailure(
        state,
        VerificationFailureKinds.technical,
        state.verification.status ?? HumanPassStatuses.unverified,
      )
  }
}

const PROVIDER_STATUSES: ReadonlySet<string> = new Set(VERIFICATION_STATUSES)

function isProviderStatus(
  status: HumanPassStatus | VerificationStatus,
): status is VerificationStatus {
  return PROVIDER_STATUSES.has(status)
}

/**
 * Reduces an outcome to a Human Pass status and a §111 failure kind. `verified`,
 * `review_required` and `rejected` mean the same in both vocabularies; provider-only statuses
 * map through `humanPassStatusForResult`. An explicit `failureKind` always wins.
 */
export function normalizeClaimVerificationOutcome(
  outcome: ClaimVerificationOutcome,
): NormalizedClaimVerificationOutcome {
  const explicit = outcome.failureKind ?? null
  if (isProviderStatus(outcome.status)) {
    const result =
      explicit === null
        ? { status: outcome.status }
        : { status: outcome.status, failureKind: explicit }
    return { status: humanPassStatusForResult(result), failureKind: failureKindForResult(result) }
  }
  return {
    status: outcome.status,
    failureKind: explicit ?? failureKindForHumanPassStatus(outcome.status),
  }
}

function withFailure(
  state: ClaimFlowState,
  kind: VerificationFailureKind,
  status: HumanPassStatus,
): ClaimFlowState {
  const failure: ClaimFailure = { kind, copyKey: CLAIM_FAILURE_COPY_KEYS[kind], status }
  return kind === VerificationFailureKinds.duplicate
    ? { ...state, step: ClaimSteps.duplicate, failure }
    : { ...state, step: ClaimSteps.human_pass, failure }
}

/** Copies exactly `status` and `failureKind` out of the outcome; nothing else can enter state. */
function applyResult(state: ClaimFlowState, outcome: ClaimVerificationOutcome): ClaimFlowState {
  const { status, failureKind } = normalizeClaimVerificationOutcome(outcome)
  const verification: ClaimVerificationState = {
    sessionId: state.verification.sessionId,
    status,
    attempts: state.verification.attempts + 1,
  }
  if (failureKind !== null) return withFailure({ ...state, verification }, failureKind, status)
  if (status === HumanPassStatuses.verifying) return { ...state, verification }
  if (status === HumanPassStatuses.verified) {
    return { ...state, step: ClaimSteps.complete, verification, failure: null }
  }
  // `unverified` / `review_required` / `rejected` always carry a kind; keep the safe branch anyway.
  return withFailure({ ...state, verification }, VerificationFailureKinds.technical, status)
}

function normalizeLabel(label: string | null): string | null {
  const trimmed = label?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}

// ---------------------------------------------------------------------------
// Copy helpers
// ---------------------------------------------------------------------------

/** The rendered §111 action for a failure kind. */
export function claimFailureCopy(kind: VerificationFailureKind): string {
  return copy[CLAIM_FAILURE_COPY_KEYS[kind]]
}

/** Copy key for the `credential` step: spec §45 step 3 for start-group, `joinThem` for join. */
export function credentialTitleCopyKey(intent: ClaimIntent | null): CopyKey | null {
  switch (intent) {
    case 'start_group':
      return 'claimToStartGroup'
    case 'join_group':
      return 'joinThem'
    case null:
      return 'claimYourPlace'
    default: {
      const exhaustive: never = intent
      throw new Error(`Unknown claim intent: ${String(exhaustive)}`)
    }
  }
}

/** Title copy key for the current step, or `null` when the screen has none from the spec. */
export function claimStepTitleCopyKey(state: ClaimFlowState): CopyKey | null {
  return state.step === ClaimSteps.credential
    ? credentialTitleCopyKey(state.intent)
    : CLAIM_STEP_TITLE_COPY_KEYS[state.step]
}

/** True once the person is a Human and the group is ready (spec §45 step 8 / §46 step 7). */
export function isClaimFinished(state: ClaimFlowState): boolean {
  return state.step === ClaimSteps.done && state.completion !== null
}
