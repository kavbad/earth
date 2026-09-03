/**
 * Web glue around the `@earth/auth` claim state machine (spec §44–§49, §111): which route each
 * step lives at, what may be navigated back to, how a claim resumes from `claim_get()` or from
 * the choices a Visitor made before signing in, and where the person lands afterwards.
 * Everything here is pure; the pages dispatch and navigate.
 */
import {
  type ClaimEvent,
  type ClaimFlags,
  type ClaimFlowState,
  type ClaimStep,
  ClaimSteps,
  type ClaimVerificationOutcome,
  type InitialClaimStateOptions,
  VerificationFailureKindSchema,
  claimStepTitleCopyKey,
  initialClaimState,
  nextStep,
} from '@earth/auth'
import type { VerificationResultDto } from '@earth/api'
import {
  type ClaimCompleteDto,
  ClaimCompleteDtoSchema,
  type ClaimIntent,
  ClaimIntentSchema,
  type ClaimStateDto,
  DEEP_LINK_PATHS,
  type HumanPassStatus,
} from '@earth/domain'
import { copy } from '@earth/ui'
import type { Route } from 'next'
import { z } from 'zod'

import { ROUTES, asRoute, conversationRoute } from '../routes'
import { type KeyValueStorage, readJson, removeKey, writeJson } from '../storage'

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export type ClaimAction = ClaimEvent | { readonly type: 'reset'; readonly state: ClaimFlowState }

/** `nextStep` plus a `reset` for resuming from the server or from stored choices. */
export function claimReducer(state: ClaimFlowState, action: ClaimAction): ClaimFlowState {
  if (action.type === 'reset') return action.state
  return nextStep(state, action)
}

// ---------------------------------------------------------------------------
// Routes per step
// ---------------------------------------------------------------------------

export function routeForStep(step: ClaimStep): Route {
  switch (step) {
    case 'gate':
      return asRoute(ROUTES.claim)
    case 'group_label':
      return asRoute(ROUTES.claimStart)
    case 'credential':
      return asRoute(ROUTES.claimCredential)
    case 'identity':
      return asRoute(ROUTES.claimIdentity)
    case 'human_pass':
    case 'verifying':
    case 'duplicate':
    case 'help':
    case 'complete':
      return asRoute(ROUTES.claimHuman)
    case 'done':
      return asRoute(ROUTES.welcome)
    default: {
      const exhaustive: never = step
      throw new Error(`Unknown claim step: ${String(exhaustive)}`)
    }
  }
}

/** Progress rank of a step: earlier screens may be revisited, later ones never skipped to. */
export function stepRank(step: ClaimStep): number {
  switch (step) {
    case 'gate':
      return 0
    case 'group_label':
      return 1
    case 'credential':
      return 2
    case 'identity':
      return 3
    case 'human_pass':
    case 'verifying':
    case 'duplicate':
    case 'help':
    case 'complete':
      return 4
    case 'done':
      return 5
    default: {
      const exhaustive: never = step
      throw new Error(`Unknown claim step: ${String(exhaustive)}`)
    }
  }
}

const IDENTITY_RANK = stepRank(ClaimSteps.identity)

/** The step a claim page stands for; `/claim/join` is the transitional entry of spec §46. */
export function stepForPathname(pathname: string): ClaimStep | null {
  switch (pathname) {
    case ROUTES.claim:
      return ClaimSteps.gate
    case ROUTES.claimStart:
      return ClaimSteps.group_label
    case ROUTES.claimJoin:
    case ROUTES.claimCredential:
      return ClaimSteps.credential
    case ROUTES.claimIdentity:
      return ClaimSteps.identity
    case ROUTES.claimHuman:
      return ClaimSteps.human_pass
    case ROUTES.welcome:
      return ClaimSteps.done
    default:
      return null
  }
}

/**
 * Where to send someone whose URL does not fit the claim state, or `null` when the page may
 * stay: nobody skips ahead; once the credential was used there is no going back before the
 * identity step; a finished claim only shows "You're on Earth".
 */
export function claimRedirectFor(state: ClaimFlowState, pathname: string): Route | null {
  const at = stepForPathname(pathname)
  if (at === null) return null
  const current = stepRank(state.step)
  const here = stepRank(at)
  if (state.step === ClaimSteps.done) return at === ClaimSteps.done ? null : asRoute(ROUTES.welcome)
  if (here > current) return routeForStep(state.step)
  if (current >= IDENTITY_RANK && here < IDENTITY_RANK) return routeForStep(state.step)
  return null
}

/**
 * The page to open after an event moved the claim forward (`chooseStart` → the label,
 * `labelSet` → the credential, `claim_start` → identity, `identitySet` → Human Pass), or `null`
 * when the person stays where they are: a step at the same rank lives on the same page, going
 * back never navigates, and `done` is pinned to `/welcome` by `claimRedirectFor`.
 */
export function routeAfterAdvance(previous: ClaimFlowState, next: ClaimFlowState): Route | null {
  if (next.step === ClaimSteps.done) return null
  return stepRank(next.step) > stepRank(previous.step) ? routeForStep(next.step) : null
}

// ---------------------------------------------------------------------------
// Resume: server state and stored choices
// ---------------------------------------------------------------------------

export function optionsFromClaimState(
  dto: ClaimStateDto,
  flags: ClaimFlags,
  failureKind?: ClaimVerificationOutcome['failureKind'],
): InitialClaimStateOptions {
  const sessionId = dto.verification.sessionId ?? null
  return {
    flags,
    intent: dto.intent,
    groupLabel: dto.groupLabel,
    inviteToken: dto.inviteToken ?? null,
    authenticated: true,
    identitySet: dto.identity !== null && dto.identity !== undefined,
    verification: {
      status: dto.verification.status,
      sessionId,
      failureKind: failureKind ?? null,
    },
  }
}

/** The machine state for a claim `claim_get()` describes (never `claimed`: that person is a Human). */
export function stateFromClaimDto(dto: ClaimStateDto, flags: ClaimFlags): ClaimFlowState {
  return initialClaimState(optionsFromClaimState(dto, flags))
}

/** A duplicate raised outside a verification result (`claim_start` / `claim_complete`). */
export function duplicateState(
  intent: ClaimIntent | null,
  flags: ClaimFlags,
  status: HumanPassStatus = 'review_required',
): ClaimFlowState {
  return initialClaimState({
    flags,
    intent,
    authenticated: true,
    identitySet: true,
    verification: { status, failureKind: 'duplicate' },
  })
}

export const PENDING_CLAIM_KEY = 'earth.claim.pending' as const

export const PendingClaimSchema = z.object({
  intent: ClaimIntentSchema.nullable(),
  groupLabel: z.string().nullable(),
  inviteToken: z.string().nullable(),
  /** Epoch ms when the claim started (for `human_claimed.durationMs`). */
  startedAt: z.number().int().nonnegative(),
})
export type PendingClaim = z.infer<typeof PendingClaimSchema>

export function pendingFromState(state: ClaimFlowState, startedAt: number): PendingClaim {
  return {
    intent: state.intent,
    groupLabel: state.groupLabel,
    inviteToken: state.inviteToken,
    startedAt,
  }
}

export function readPendingClaim(store: KeyValueStorage | null): PendingClaim | null {
  return readJson(store, PENDING_CLAIM_KEY, (value) => {
    const parsed = PendingClaimSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  })
}

export function writePendingClaim(store: KeyValueStorage | null, pending: PendingClaim): void {
  writeJson(store, PENDING_CLAIM_KEY, pending)
}

export function clearPendingClaim(store: KeyValueStorage | null): void {
  removeKey(store, PENDING_CLAIM_KEY)
}

/** A Visitor's choices before the credential step, as a machine state. */
export function stateFromPending(pending: PendingClaim | null, flags: ClaimFlags): ClaimFlowState {
  return initialClaimState({
    flags,
    intent: pending?.intent ?? null,
    groupLabel: pending?.groupLabel ?? null,
    inviteToken: pending?.inviteToken ?? null,
  })
}

// ---------------------------------------------------------------------------
// Completion ("You're on Earth", spec §49)
// ---------------------------------------------------------------------------

export const CLAIM_COMPLETION_KEY = 'earth.claim.completion' as const

export const ClaimCompletionRecordSchema = ClaimCompleteDtoSchema.extend({
  intent: ClaimIntentSchema.nullable(),
})
export type ClaimCompletionRecord = z.infer<typeof ClaimCompletionRecordSchema>

export function readCompletion(store: KeyValueStorage | null): ClaimCompletionRecord | null {
  return readJson(store, CLAIM_COMPLETION_KEY, (value) => {
    const parsed = ClaimCompletionRecordSchema.safeParse(value)
    return parsed.success ? parsed.data : null
  })
}

export function writeCompletion(
  store: KeyValueStorage | null,
  completion: ClaimCompleteDto,
  intent: ClaimIntent | null,
): void {
  writeJson(store, CLAIM_COMPLETION_KEY, { ...completion, intent })
}

export function clearCompletion(store: KeyValueStorage | null): void {
  removeKey(store, CLAIM_COMPLETION_KEY)
}

/** Spec §46 step 8 / §49: the group's conversation, never a generic Home. */
export function destinationAfterClaim(completion: Pick<ClaimCompleteDto, 'conversationId'>): Route {
  return conversationRoute(completion.conversationId)
}

// ---------------------------------------------------------------------------
// Verification polling
// ---------------------------------------------------------------------------

/** Poll every 1.5 s, easing to 5 s (ms). */
export function pollDelayMs(attempts: number): number {
  return Math.min(1_500 + Math.max(0, attempts) * 500, 5_000)
}

/** ~10 minutes of polling before a hosted step is treated as a technical failure. */
export const VERIFICATION_POLL_MAX_ATTEMPTS = 120

export function outcomeFromResult(result: VerificationResultDto): ClaimVerificationOutcome {
  const kind = VerificationFailureKindSchema.safeParse(result.failureKind)
  return { status: result.status, failureKind: kind.success ? kind.data : null }
}

export function isVerificationSettled(status: HumanPassStatus): boolean {
  return status !== 'verifying'
}

/** `human_verification_failed.outcome` (spec §97) — only statuses that are a decision, not a hiccup. */
export function failureOutcomeFor(status: HumanPassStatus): 'review_required' | 'rejected' | null {
  return status === 'review_required' || status === 'rejected' ? status : null
}

// ---------------------------------------------------------------------------
// Invite tokens and titles
// ---------------------------------------------------------------------------

/** A raw token or any URL containing `/g/<token>` (spec §44 "Input/open an invite"). */
export function parseInviteToken(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  const marker = DEEP_LINK_PATHS.groupInvite
  const at = trimmed.indexOf(marker)
  if (at >= 0) {
    const rest = trimmed.slice(at + marker.length)
    const token = rest.split(/[/?#\s]/)[0] ?? ''
    try {
      return token === '' ? null : decodeURIComponent(token)
    } catch {
      return null
    }
  }
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed
  return null
}

/** Title for the current step from the canonical copy (`null` when the spec fixes none). */
export function claimStepTitle(state: ClaimFlowState): string | null {
  const key = claimStepTitleCopyKey(state)
  if (key === null) return null
  const value = copy[key]
  return typeof value === 'string' ? value : null
}

/** `Enter Weekend Crew`, or a neutral line for a group that has no name yet. */
export function enterGroupLabel(groupName: string | null, fallback: string): string {
  return groupName === null || groupName.trim() === '' ? fallback : copy.enterGroup(groupName)
}
