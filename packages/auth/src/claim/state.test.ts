import { describe, expect, it } from 'vitest'

import { FEATURE_FLAG_DEFAULTS } from '@earth/config'
import {
  type ClaimCompleteDto,
  type ClaimStateDto,
  EARTH_ERROR_CODES,
  HUMAN_PASS_STATUS,
  type HumanId,
} from '@earth/domain'
import { copy } from '@earth/ui'

import { mockResultFor } from '../verification/mock'
import { type VerificationResult } from '../verification/types'
import {
  CLAIM_FAILURE_COPY_KEYS,
  CLAIM_STEPS,
  CLAIM_STEP_TITLE_COPY_KEYS,
  type ClaimEvent,
  type ClaimFlags,
  type ClaimFlowState,
  type ClaimVerificationOutcome,
  DUPLICATE_ACTIONS,
  REVIEW_RESUMABLE_HELP_KINDS,
  claimFailureCopy,
  claimStepTitleCopyKey,
  initialClaimState,
  isClaimFinished,
  nextStep,
  normalizeClaimVerificationOutcome,
} from './state'

const HUMAN = '11111111-1111-4111-8111-111111111111' as HumanId
const OTHER_HUMAN = '22222222-2222-4222-8222-222222222222' as HumanId

const GATED: ClaimFlags = { GROUP_ANCHORED_CLAIM_REQUIRED: true }
const OPEN: ClaimFlags = { GROUP_ANCHORED_CLAIM_REQUIRED: false }

const COMPLETION: ClaimCompleteDto = {
  humanId: HUMAN,
  groupId: '33333333-3333-4333-8333-333333333333' as ClaimCompleteDto['groupId'],
  conversationId: '44444444-4444-4444-8444-444444444444' as ClaimCompleteDto['conversationId'],
}

/** A full provider result, as the server tier holds it — the machine must only read two fields. */
const METADATA_MARKER = 'face_template_secret'
const verified = (): VerificationResult => ({
  ...mockResultFor('verified', 'ref', OTHER_HUMAN),
  metadata: { vendor: { template: METADATA_MARKER } },
})
const pending = (): VerificationResult => ({
  status: 'pending',
  riskLevel: null,
  providerReference: 'ref',
  metadata: { template: METADATA_MARKER },
})

function run(state: ClaimFlowState, events: readonly ClaimEvent[]): ClaimFlowState {
  return events.reduce((current, event) => nextStep(current, event), state)
}

function toHumanPass(flags: ClaimFlags = GATED): ClaimFlowState {
  return run(initialClaimState({ flags }), [
    { type: 'chooseStart' },
    { type: 'labelSet', label: 'Weekend Crew' },
    { type: 'authenticated' },
    { type: 'identitySet' },
  ])
}

function toComplete(): ClaimFlowState {
  return run(toHumanPass(), [
    { type: 'verificationStarted', sessionId: 's' },
    { type: 'verificationResult', result: verified() },
  ])
}

describe('initialClaimState', () => {
  it('starts at the gate while the launch flag is on and matches the flag defaults', () => {
    expect(FEATURE_FLAG_DEFAULTS.GROUP_ANCHORED_CLAIM_REQUIRED).toBe(true)
    const state = initialClaimState({ flags: GATED })
    expect(state.step).toBe('gate')
    expect(state.intent).toBeNull()
    expect(claimStepTitleCopyKey(state)).toBe('claimGate')
    expect(copy[claimStepTitleCopyKey(state) ?? 'claimGate']).toBe('Earth starts with your people.')
  })

  it('skips the gate straight to the credential when the flag is off', () => {
    const state = initialClaimState({ flags: OPEN })
    expect(state.step).toBe('credential')
    expect(state.intent).toBeNull()
    expect(claimStepTitleCopyKey(state)).toBe('claimYourPlace')
  })

  it('treats an invite token as the join-group intent, skipping the gate', () => {
    const state = initialClaimState({ flags: GATED, inviteToken: 'tok' })
    expect(state.step).toBe('credential')
    expect(state.intent).toBe('join_group')
    expect(state.inviteToken).toBe('tok')
    expect(claimStepTitleCopyKey(state)).toBe('joinThem')
  })

  it('resumes at the right step from server-side claim state', () => {
    expect(
      initialClaimState({ flags: GATED, intent: 'start_group', authenticated: true }).step,
    ).toBe('identity')
    expect(
      initialClaimState({
        flags: GATED,
        intent: 'start_group',
        authenticated: true,
        identitySet: true,
      }).step,
    ).toBe('human_pass')
    // An identity implies a credential (spec §45 steps 4–5).
    const implied = initialClaimState({ flags: GATED, intent: 'start_group', identitySet: true })
    expect(implied.step).toBe('human_pass')
    expect(implied.authenticated).toBe(true)
  })

  describe('resumes the Human Pass state from claim_get() (spec §45 steps 6–8)', () => {
    const base = { flags: GATED, intent: 'start_group', identitySet: true } as const

    it('verified → complete, so the person is not asked to prove they are human again', () => {
      const state = initialClaimState({ ...base, verification: { status: 'verified' } })
      expect(state.step).toBe('complete')
      expect(state.verification).toEqual({ sessionId: null, status: 'verified', attempts: 0 })
      expect(state.failure).toBeNull()
    })

    it('verifying with a session → verifying (a hosted flow the person left and came back to)', () => {
      const state = initialClaimState({
        ...base,
        verification: { status: 'verifying', sessionId: 'vs_1' },
      })
      expect(state.step).toBe('verifying')
      expect(state.verification.sessionId).toBe('vs_1')
      // ... without a session there is nothing to poll: start again.
      expect(initialClaimState({ ...base, verification: { status: 'verifying' } }).step).toBe(
        'human_pass',
      )
    })

    it('unverified → human_pass without a failure', () => {
      const state = initialClaimState({ ...base, verification: { status: 'unverified' } })
      expect(state.step).toBe('human_pass')
      expect(state.failure).toBeNull()
    })

    it('review_required / rejected → human_pass with "Get help verifying"; a named duplicate → §48', () => {
      for (const status of ['review_required', 'rejected'] as const) {
        const state = initialClaimState({ ...base, verification: { status } })
        expect(state.step).toBe('human_pass')
        expect(state.failure).toEqual({ kind: 'inconclusive', copyKey: 'getHelpVerifying', status })
      }
      const duplicate = initialClaimState({
        ...base,
        verification: { status: 'review_required', failureKind: 'duplicate' },
      })
      expect(duplicate.step).toBe('duplicate')
      expect(duplicate.failure?.copyKey).toBe('recoverYourPlace')
    })

    it('accepts ClaimStateDto.verification as-is and ignores it before the identity is set', () => {
      const dto: ClaimStateDto['verification'] = { status: 'verified', sessionId: 'vs_2' }
      expect(initialClaimState({ ...base, verification: dto }).step).toBe('complete')
      expect(
        initialClaimState({
          flags: GATED,
          intent: 'start_group',
          authenticated: true,
          verification: dto,
        }).step,
      ).toBe('identity')
      expect(initialClaimState({ ...base, verification: null }).step).toBe('human_pass')
    })

    it('handles every Human Pass status', () => {
      for (const status of HUMAN_PASS_STATUS) {
        expect(() => initialClaimState({ ...base, verification: { status } })).not.toThrow()
      }
    })
  })
})

describe('nextStep — start-group happy path (spec §45)', () => {
  it('walks gate → group_label → credential → identity → human_pass → verifying → complete → done', () => {
    const steps: string[] = []
    let state = initialClaimState({ flags: GATED })
    const apply = (event: ClaimEvent) => {
      state = nextStep(state, event)
      steps.push(state.step)
    }

    apply({ type: 'chooseStart' })
    expect(state.intent).toBe('start_group')
    expect(claimStepTitleCopyKey(state)).toBe('optionalGroupName')
    apply({ type: 'labelSet', label: '  Weekend Crew ' })
    expect(state.groupLabel).toBe('Weekend Crew')
    expect(claimStepTitleCopyKey(state)).toBe('claimToStartGroup')
    apply({ type: 'authenticated' })
    expect(state.authenticated).toBe(true)
    apply({ type: 'identitySet' })
    expect(state.identitySet).toBe(true)
    expect(claimStepTitleCopyKey(state)).toBe('proveHuman')
    apply({ type: 'verificationStarted', sessionId: 's1' })
    expect(state.verification).toEqual({ sessionId: 's1', status: 'verifying', attempts: 0 })
    apply({ type: 'verificationResult', result: pending() })
    expect(state.verification.attempts).toBe(1)
    apply({ type: 'verificationResult', result: verified() })
    expect(state.failure).toBeNull()
    // Step 8 (the transaction) comes before step 9 ("You're on Earth"): no title yet.
    expect(claimStepTitleCopyKey(state)).toBeNull()
    expect(isClaimFinished(state)).toBe(false)
    apply({ type: 'completed', completion: COMPLETION })
    expect(isClaimFinished(state)).toBe(true)
    expect(state.completion).toEqual(COMPLETION)
    expect(claimStepTitleCopyKey(state)).toBe('youreOnEarth')
    expect(copy.youreOnEarth).toBe("You're on Earth.")

    expect(steps).toEqual([
      'group_label',
      'credential',
      'identity',
      'human_pass',
      'verifying',
      'verifying',
      'complete',
      'done',
    ])
  })

  it('allows skipping the label (spec §45 step 2)', () => {
    const state = run(initialClaimState({ flags: GATED }), [
      { type: 'chooseStart' },
      { type: 'labelSet', label: null },
    ])
    expect(state.step).toBe('credential')
    expect(state.groupLabel).toBeNull()
  })

  it('shows "You\'re on Earth" only once the Human exists (spec §45 steps 8–9, §49)', () => {
    expect(CLAIM_STEP_TITLE_COPY_KEYS.complete).toBeNull()
    expect(CLAIM_STEP_TITLE_COPY_KEYS.done).toBe('youreOnEarth')
    for (const step of CLAIM_STEPS) {
      if (step !== 'done') expect(CLAIM_STEP_TITLE_COPY_KEYS[step]).not.toBe('youreOnEarth')
    }
  })
})

describe('nextStep — join-group happy path (spec §46)', () => {
  it('goes from the gate to the credential with the invite, then straight through', () => {
    const state = run(initialClaimState({ flags: GATED }), [
      { type: 'chooseJoin', inviteToken: 'inv-1' },
      { type: 'authenticated' },
      { type: 'identitySet' },
      { type: 'verificationStarted', sessionId: 's2' },
      { type: 'verificationResult', result: verified() },
      { type: 'completed', completion: COMPLETION },
    ])
    expect(state.intent).toBe('join_group')
    expect(state.inviteToken).toBe('inv-1')
    expect(state.groupLabel).toBeNull()
    expect(state.step).toBe('done')
    expect(isClaimFinished(state)).toBe(true)
  })
})

describe('nextStep — flag awareness (spec §44)', () => {
  it('refuses to continue without a group while the launch flag is on', () => {
    const gate = initialClaimState({ flags: GATED })
    expect(nextStep(gate, { type: 'continueWithoutGroup' })).toBe(gate)
  })

  it('lets the gate go straight to the credential when the flag is off', () => {
    const gate: ClaimFlowState = { ...initialClaimState({ flags: OPEN }), step: 'gate' }
    const next = nextStep(gate, { type: 'continueWithoutGroup' })
    expect(next.step).toBe('credential')
    expect(next.intent).toBeNull()
    // Choosing a group still works with the flag off.
    expect(nextStep(gate, { type: 'chooseStart' }).step).toBe('group_label')
  })
})

describe('nextStep — verification failures (spec §111)', () => {
  it('technical → back to human_pass with "Try again"', () => {
    const state = run(toHumanPass(), [
      { type: 'verificationStarted', sessionId: 's3' },
      { type: 'verificationResult', result: mockResultFor('technical', 'ref', OTHER_HUMAN) },
    ])
    expect(state.step).toBe('human_pass')
    expect(state.failure).toEqual({ kind: 'technical', copyKey: 'tryAgain', status: 'unverified' })
    expect(copy[state.failure?.copyKey ?? 'tryAgain']).toBe('Try again')
    expect(claimFailureCopy('technical')).toBe('Try again')
    // Trying again clears the failure and starts a new session.
    const retried = nextStep(state, { type: 'verificationStarted', sessionId: 's4' })
    expect(retried.step).toBe('verifying')
    expect(retried.failure).toBeNull()
    expect(retried.verification).toEqual({ sessionId: 's4', status: 'verifying', attempts: 1 })
  })

  it.each([
    ['inconclusive', 'review_required'],
    ['rejected', 'rejected'],
  ] as const)('%s → back to human_pass with "Get help verifying"', (outcome, status) => {
    const state = run(toHumanPass(), [
      { type: 'verificationStarted', sessionId: 's5' },
      { type: 'verificationResult', result: mockResultFor(outcome, 'ref', OTHER_HUMAN) },
    ])
    expect(state.step).toBe('human_pass')
    expect(state.failure).toEqual({ kind: 'inconclusive', copyKey: 'getHelpVerifying', status })
    expect(copy[state.failure?.copyKey ?? 'getHelpVerifying']).toBe('Get help verifying')
    // Spec §79: asking for help opens an inconclusive review.
    const help = nextStep(state, { type: 'needHelp' })
    expect(help.step).toBe('help')
    expect(help.helpKind).toBe('inconclusive')
  })

  it('a review without a named Human is inconclusive, not a duplicate', () => {
    const result: VerificationResult = {
      status: 'review_required',
      riskLevel: 'medium',
      providerReference: 'ref',
      duplicateOfHumanId: null,
      metadata: {},
    }
    const state = run(toHumanPass(), [
      { type: 'verificationStarted', sessionId: 's6' },
      { type: 'verificationResult', result },
    ])
    expect(state.step).toBe('human_pass')
    expect(state.failure?.kind).toBe('inconclusive')
  })

  it('duplicate → the §48 screen with "Recover your place" and every action leads to help', () => {
    const state = run(toHumanPass(), [
      { type: 'verificationStarted', sessionId: 's7' },
      { type: 'verificationResult', result: mockResultFor('duplicate', 'ref', OTHER_HUMAN) },
    ])
    expect(state.step).toBe('duplicate')
    expect(state.failure).toEqual({
      kind: 'duplicate',
      copyKey: 'recoverYourPlace',
      status: 'review_required',
    })
    expect(claimStepTitleCopyKey(state)).toBe('alreadyOnEarth')
    expect(copy.alreadyOnEarth).toBe("Looks like you're already on Earth.")

    expect(DUPLICATE_ACTIONS.map((a) => [a.event, copy[a.copyKey]])).toEqual([
      ['recover', 'Recover my place'],
      ['notMe', "This isn't me"],
      ['needHelp', 'I need help'],
      ['safety', 'Safety issue'],
    ])
    expect(nextStep(state, { type: 'recover' })).toMatchObject({
      step: 'help',
      helpKind: 'recovery',
    })
    expect(nextStep(state, { type: 'notMe' })).toMatchObject({
      step: 'help',
      helpKind: 'duplicate',
    })
    expect(nextStep(state, { type: 'needHelp' })).toMatchObject({ step: 'help', helpKind: 'help' })
    expect(nextStep(state, { type: 'safety' })).toMatchObject({ step: 'help', helpKind: 'safety' })
    // Never a second Human: the duplicate screen has no "continue" edge.
    expect(nextStep(state, { type: 'verificationStarted', sessionId: 's8' })).toBe(state)
    expect(nextStep(state, { type: 'completed', completion: COMPLETION })).toBe(state)
    expect(nextStep(state, { type: 'verificationResult', result: verified() })).toBe(state)
  })

  it('maps every failure kind to a real copy key with distinct wording', () => {
    const rendered = Object.values(CLAIM_FAILURE_COPY_KEYS).map((key) => copy[key])
    expect(rendered).toEqual(['Try again', 'Get help verifying', 'Recover your place'])
    expect(new Set(rendered).size).toBe(3)
    expect(rendered).not.toContain('Verification failed.')
  })

  it('lets a pending session be superseded by a new one ("Try again" on a stuck flow)', () => {
    const state = run(toHumanPass(), [
      { type: 'verificationStarted', sessionId: 's9' },
      { type: 'verificationResult', result: pending() },
      { type: 'verificationStarted', sessionId: 's10' },
    ])
    expect(state.step).toBe('verifying')
    expect(state.verification).toEqual({ sessionId: 's10', status: 'verifying', attempts: 1 })
  })
})

describe('nextStep — what the client actually receives (Human Pass status, spec §111)', () => {
  const started = (): ClaimFlowState =>
    nextStep(toHumanPass(), { type: 'verificationStarted', sessionId: 'vs' })
  const apply = (result: ClaimVerificationOutcome): ClaimFlowState =>
    nextStep(started(), { type: 'verificationResult', result })

  it('verifying → keep polling; verified → complete', () => {
    expect(apply({ status: 'verifying' })).toMatchObject({
      step: 'verifying',
      verification: { status: 'verifying', attempts: 1 },
    })
    expect(apply({ status: 'verified' })).toMatchObject({ step: 'complete', failure: null })
    expect(apply({ status: 'verified', failureKind: null })).toMatchObject({ step: 'complete' })
  })

  it('unverified → "Try again"; review_required / rejected → "Get help verifying"', () => {
    expect(apply({ status: 'unverified' }).failure).toEqual({
      kind: 'technical',
      copyKey: 'tryAgain',
      status: 'unverified',
    })
    expect(apply({ status: 'review_required' }).failure).toEqual({
      kind: 'inconclusive',
      copyKey: 'getHelpVerifying',
      status: 'review_required',
    })
    expect(apply({ status: 'rejected' }).failure).toEqual({
      kind: 'inconclusive',
      copyKey: 'getHelpVerifying',
      status: 'rejected',
    })
  })

  it('an explicit failure kind from the server wins, and duplicate opens §48', () => {
    expect(apply({ status: 'review_required', failureKind: 'duplicate' })).toMatchObject({
      step: 'duplicate',
      failure: { kind: 'duplicate', copyKey: 'recoverYourPlace' },
    })
    expect(apply({ status: 'review_required', failureKind: 'technical' })).toMatchObject({
      step: 'human_pass',
      failure: { kind: 'technical', copyKey: 'tryAgain' },
    })
    // A "verified" that names a failure is never trusted as verified.
    expect(apply({ status: 'verified', failureKind: 'duplicate' }).step).toBe('duplicate')
    expect(apply({ status: 'verified', failureKind: 'technical' }).step).toBe('human_pass')
  })

  it('normalizes provider and Human Pass vocabularies to the same thing', () => {
    expect(normalizeClaimVerificationOutcome({ status: 'pending' })).toEqual({
      status: 'verifying',
      failureKind: null,
    })
    expect(normalizeClaimVerificationOutcome({ status: 'error' })).toEqual({
      status: 'unverified',
      failureKind: 'technical',
    })
    expect(normalizeClaimVerificationOutcome({ status: 'inconclusive' })).toEqual({
      status: 'review_required',
      failureKind: 'inconclusive',
    })
    expect(normalizeClaimVerificationOutcome({ status: 'review_required' })).toEqual(
      normalizeClaimVerificationOutcome({ status: 'inconclusive' }),
    )
    expect(
      normalizeClaimVerificationOutcome({ status: 'verified', failureKind: 'duplicate' }),
    ).toEqual({ status: 'review_required', failureKind: 'duplicate' })
  })

  it('never lets provider metadata, the risk level or the matched Human into client state', () => {
    const results: VerificationResult[] = [
      verified(),
      pending(),
      mockResultFor('duplicate', 'ref', OTHER_HUMAN),
      {
        ...mockResultFor('technical', 'ref', OTHER_HUMAN),
        metadata: { template: METADATA_MARKER },
      },
    ]
    for (const result of results) {
      const state = nextStep(started(), { type: 'verificationResult', result })
      const serialized = JSON.stringify(state)
      expect(serialized).not.toContain(METADATA_MARKER)
      expect(serialized).not.toContain(OTHER_HUMAN)
      expect(serialized).not.toContain('providerReference')
      expect(serialized).not.toContain('riskLevel')
      expect(serialized).not.toContain('metadata')
      expect(Object.keys(state.verification).sort()).toEqual(['attempts', 'sessionId', 'status'])
    }
  })
})

describe('nextStep — claim_complete() outcomes (spec §45 step 8, §48; DB_API §1)', () => {
  it('duplicate_human → the §48 screen, never done', () => {
    const state = nextStep(toComplete(), { type: 'completeFailed', code: 'duplicate_human' })
    expect(state.step).toBe('duplicate')
    expect(state.failure).toEqual({
      kind: 'duplicate',
      copyKey: 'recoverYourPlace',
      status: 'verified',
    })
    expect(state.completion).toBeNull()
    expect(isClaimFinished(state)).toBe(false)
    expect(claimStepTitleCopyKey(state)).toBe('alreadyOnEarth')
  })

  it('claim_identity_missing → back to identity', () => {
    const state = nextStep(toComplete(), { type: 'completeFailed', code: 'claim_identity_missing' })
    expect(state.step).toBe('identity')
    expect(state.identitySet).toBe(false)
    expect(state.failure).toBeNull()
  })

  it('verification_pending → "Get help verifying"; verification_required → "Try again"', () => {
    const pendingReview = nextStep(toComplete(), {
      type: 'completeFailed',
      code: 'verification_pending',
    })
    expect(pendingReview.step).toBe('human_pass')
    expect(pendingReview.failure?.copyKey).toBe('getHelpVerifying')

    const required = nextStep(toComplete(), {
      type: 'completeFailed',
      code: 'verification_required',
    })
    expect(required.step).toBe('human_pass')
    expect(required.failure).toEqual({
      kind: 'technical',
      copyKey: 'tryAgain',
      status: 'unverified',
    })
    expect(required.verification.status).toBe('unverified')
  })

  it('every other code is a technical failure with "Try again" — never a generic message', () => {
    for (const code of EARTH_ERROR_CODES) {
      const state = nextStep(toComplete(), { type: 'completeFailed', code })
      expect(state).not.toBe(toComplete())
      expect(state.step).not.toBe('done')
      expect(state.completion).toBeNull()
      if (
        code !== 'duplicate_human' &&
        code !== 'claim_identity_missing' &&
        code !== 'verification_pending' &&
        code !== 'verification_required'
      ) {
        expect(state.step).toBe('human_pass')
        expect(state.failure).toMatchObject({ kind: 'technical', copyKey: 'tryAgain' })
      }
    }
  })

  it('can try the transaction again after a technical failure', () => {
    const state = run(toComplete(), [
      { type: 'completeFailed', code: 'internal' },
      { type: 'verificationStarted', sessionId: 's11' },
      { type: 'verificationResult', result: { status: 'verified' } },
      { type: 'completed', completion: COMPLETION },
    ])
    expect(isClaimFinished(state)).toBe(true)
  })
})

describe('nextStep — help and reviews (spec §48, §79, §80)', () => {
  const inconclusiveHelp = (): ClaimFlowState => nextStep(toHumanPass(), { type: 'needHelp' })
  const duplicateHelp = (event: 'recover' | 'notMe' | 'needHelp' | 'safety'): ClaimFlowState =>
    run(toHumanPass(), [
      { type: 'verificationStarted', sessionId: 's12' },
      { type: 'verificationResult', result: mockResultFor('duplicate', 'ref', OTHER_HUMAN) },
      { type: event },
    ])

  it('an approved review continues to complete (claim_complete accepts it)', () => {
    expect(REVIEW_RESUMABLE_HELP_KINDS).toEqual(['help', 'inconclusive', 'duplicate'])
    const approved = nextStep(inconclusiveHelp(), { type: 'reviewResolved', status: 'approved' })
    expect(approved.step).toBe('complete')
    expect(approved.failure).toBeNull()
    expect(
      nextStep(duplicateHelp('notMe'), { type: 'reviewResolved', status: 'approved' }).step,
    ).toBe('complete')
    expect(
      nextStep(duplicateHelp('needHelp'), { type: 'reviewResolved', status: 'approved' }).step,
    ).toBe('complete')
  })

  it('a rejected review goes back to human_pass with "Get help verifying", an open one waits', () => {
    const rejected = nextStep(inconclusiveHelp(), { type: 'reviewResolved', status: 'rejected' })
    expect(rejected.step).toBe('human_pass')
    expect(rejected.failure).toEqual({
      kind: 'inconclusive',
      copyKey: 'getHelpVerifying',
      status: 'rejected',
    })
    const help = inconclusiveHelp()
    expect(nextStep(help, { type: 'reviewResolved', status: 'open' })).toBe(help)
  })

  it('recovery and safety cases never resume this claim (spec §80)', () => {
    for (const event of ['recover', 'safety'] as const) {
      const help = duplicateHelp(event)
      expect(nextStep(help, { type: 'reviewResolved', status: 'approved' })).toBe(help)
    }
  })
})

describe('nextStep — invalid events', () => {
  it('returns the same state reference for events not allowed at the step', () => {
    const gate = initialClaimState({ flags: GATED })
    for (const event of [
      { type: 'labelSet', label: 'x' },
      { type: 'authenticated' },
      { type: 'identitySet' },
      { type: 'verificationStarted', sessionId: 's' },
      { type: 'verificationResult', result: verified() },
      { type: 'completed', completion: COMPLETION },
      { type: 'completeFailed', code: 'internal' },
      { type: 'reviewResolved', status: 'approved' },
      { type: 'recover' },
      { type: 'notMe' },
      { type: 'needHelp' },
      { type: 'safety' },
    ] as const satisfies readonly ClaimEvent[]) {
      expect(nextStep(gate, event)).toBe(gate)
    }
    const done = run(toHumanPass(), [
      { type: 'verificationStarted', sessionId: 's' },
      { type: 'verificationResult', result: verified() },
      { type: 'completed', completion: COMPLETION },
    ])
    expect(nextStep(done, { type: 'chooseStart' })).toBe(done)
    expect(nextStep(done, { type: 'completeFailed', code: 'duplicate_human' })).toBe(done)
    const help = nextStep(toHumanPass(), { type: 'needHelp' })
    expect(nextStep(help, { type: 'authenticated' })).toBe(help)
    const complete = toComplete()
    expect(nextStep(complete, { type: 'verificationResult', result: verified() })).toBe(complete)
    expect(nextStep(complete, { type: 'verificationStarted', sessionId: 'x' })).toBe(complete)
  })

  it('covers every step in the title table', () => {
    for (const step of CLAIM_STEPS) {
      const state: ClaimFlowState = { ...initialClaimState({ flags: GATED }), step }
      expect(() => claimStepTitleCopyKey(state)).not.toThrow()
    }
  })
})
