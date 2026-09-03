import { CLAIM_FLAG_KEY, ClaimSteps, type ClaimFlags, initialClaimState } from '@earth/auth'
import { fixtures } from '@earth/api/testing'
import { ClaimStateDtoSchema } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '../routes'
import { createMemoryStorage } from '../storage'
import {
  claimReducer,
  claimRedirectFor,
  claimStepTitle,
  destinationAfterClaim,
  duplicateState,
  enterGroupLabel,
  failureOutcomeFor,
  outcomeFromResult,
  parseInviteToken,
  pendingFromState,
  pollDelayMs,
  readCompletion,
  readPendingClaim,
  routeAfterAdvance,
  routeForStep,
  stateFromClaimDto,
  stateFromPending,
  writeCompletion,
  writePendingClaim,
} from './flow'

const flags: ClaimFlags = { [CLAIM_FLAG_KEY]: true }
const flagsOff: ClaimFlags = { [CLAIM_FLAG_KEY]: false }

describe('routeForStep', () => {
  it('assigns each step its page', () => {
    expect(routeForStep('gate')).toBe(ROUTES.claim)
    expect(routeForStep('group_label')).toBe(ROUTES.claimStart)
    expect(routeForStep('credential')).toBe(ROUTES.claimCredential)
    expect(routeForStep('identity')).toBe(ROUTES.claimIdentity)
    for (const step of ['human_pass', 'verifying', 'duplicate', 'help', 'complete'] as const) {
      expect(routeForStep(step)).toBe(ROUTES.claimHuman)
    }
    expect(routeForStep('done')).toBe(ROUTES.welcome)
  })
})

describe('claimRedirectFor', () => {
  it('sends a fresh Visitor at a later page back to the gate', () => {
    const state = stateFromPending(null, flags)
    expect(state.step).toBe(ClaimSteps.gate)
    expect(claimRedirectFor(state, ROUTES.claimIdentity)).toBe(ROUTES.claim)
    expect(claimRedirectFor(state, ROUTES.claimHuman)).toBe(ROUTES.claim)
    expect(claimRedirectFor(state, ROUTES.claim)).toBeNull()
  })

  it('lets a person revisit earlier choices before the credential is used', () => {
    const state = claimReducer(stateFromPending(null, flags), { type: 'chooseStart' })
    expect(state.step).toBe(ClaimSteps.group_label)
    expect(claimRedirectFor(state, ROUTES.claim)).toBeNull()
    expect(claimRedirectFor(state, ROUTES.claimCredential)).toBe(ROUTES.claimStart)
  })

  it('never goes back before identity once the credential exists', () => {
    const state = initialClaimState({ flags, intent: 'start_group', authenticated: true })
    expect(state.step).toBe(ClaimSteps.identity)
    expect(claimRedirectFor(state, ROUTES.claim)).toBe(ROUTES.claimIdentity)
    expect(claimRedirectFor(state, ROUTES.claimCredential)).toBe(ROUTES.claimIdentity)
    expect(claimRedirectFor(state, ROUTES.claimIdentity)).toBeNull()
  })

  it('leaves non-claim pages alone and pins a finished claim to /welcome', () => {
    const state = stateFromPending(null, flags)
    expect(claimRedirectFor(state, '/home')).toBeNull()
    const complete = initialClaimState({
      flags,
      intent: 'join_group',
      inviteToken: 't',
      identitySet: true,
      verification: { status: 'verified' },
    })
    const done = claimReducer(complete, {
      type: 'completed',
      completion: {
        humanId: '11111111-1111-4111-8111-111111111111' as never,
        groupId: '22222222-2222-4222-8222-222222222222' as never,
        conversationId: '33333333-3333-4333-8333-333333333333' as never,
      },
    })
    expect(done.step).toBe(ClaimSteps.done)
    expect(claimRedirectFor(done, ROUTES.claimHuman)).toBe(ROUTES.welcome)
    expect(claimRedirectFor(done, ROUTES.welcome)).toBeNull()
  })
})

describe('routeAfterAdvance', () => {
  it('opens the next page when an event moves the claim forward', () => {
    const gate = stateFromPending(null, flags)
    const label = claimReducer(gate, { type: 'chooseStart' })
    expect(routeAfterAdvance(gate, label)).toBe(ROUTES.claimStart)
    const credential = claimReducer(label, { type: 'labelSet', label: 'Weekend Crew' })
    expect(routeAfterAdvance(label, credential)).toBe(ROUTES.claimCredential)
    expect(routeAfterAdvance(gate, claimReducer(gate, { type: 'chooseJoin', inviteToken: 't' }))).toBe(
      ROUTES.claimCredential,
    )
    const identity = initialClaimState({ flags, intent: 'start_group', authenticated: true })
    expect(routeAfterAdvance(credential, identity)).toBe(ROUTES.claimIdentity)
    const humanPass = claimReducer(identity, { type: 'identitySet' })
    expect(routeAfterAdvance(identity, humanPass)).toBe(ROUTES.claimHuman)
  })

  it('stays put within a page, when going back, and when the claim is done', () => {
    const humanPass = initialClaimState({
      flags,
      intent: 'start_group',
      authenticated: true,
      identitySet: true,
    })
    const verifying = claimReducer(humanPass, { type: 'verificationStarted', sessionId: 's' })
    expect(routeAfterAdvance(humanPass, verifying)).toBeNull()
    const label = claimReducer(stateFromPending(null, flags), { type: 'chooseStart' })
    expect(routeAfterAdvance(label, stateFromPending(null, flags))).toBeNull()
    const complete = initialClaimState({
      flags,
      intent: 'start_group',
      identitySet: true,
      verification: { status: 'verified' },
    })
    const done = claimReducer(complete, {
      type: 'completed',
      completion: {
        humanId: '11111111-1111-4111-8111-111111111111' as never,
        groupId: '22222222-2222-4222-8222-222222222222' as never,
        conversationId: '33333333-3333-4333-8333-333333333333' as never,
      },
    })
    expect(routeAfterAdvance(complete, done)).toBeNull()
  })
})

describe('claimReducer', () => {
  it('resets wholesale and otherwise defers to the state machine', () => {
    const start = stateFromPending(null, flags)
    const chosen = claimReducer(start, { type: 'chooseJoin', inviteToken: 'abc' })
    expect(chosen.step).toBe(ClaimSteps.credential)
    expect(chosen.inviteToken).toBe('abc')
    expect(claimReducer(chosen, { type: 'reset', state: start })).toBe(start)
  })

  it('refuses "continue without a group" while the launch gate is on (spec §44)', () => {
    const start = stateFromPending(null, flags)
    expect(claimReducer(start, { type: 'continueWithoutGroup' })).toBe(start)
    expect(
      claimReducer(stateFromPending(null, flagsOff), { type: 'continueWithoutGroup' }).step,
    ).toBe(ClaimSteps.credential)
  })
})

describe('resume', () => {
  it('rebuilds the machine from claim_get() at the right step', () => {
    const started = ClaimStateDtoSchema.parse(
      fixtures.claimState({
        status: 'started',
        identity: null,
        verification: { status: 'unverified' },
      }),
    )
    expect(stateFromClaimDto(started, flags).step).toBe(ClaimSteps.identity)
    const identitySet = ClaimStateDtoSchema.parse(
      fixtures.claimState({ status: 'identity_set', verification: { status: 'unverified' } }),
    )
    expect(stateFromClaimDto(identitySet, flags).step).toBe(ClaimSteps.human_pass)
    const verifying = ClaimStateDtoSchema.parse(
      fixtures.claimState({
        status: 'verifying',
        verification: { status: 'verifying', sessionId: 's1' },
      }),
    )
    const resumed = stateFromClaimDto(verifying, flags)
    expect(resumed.step).toBe(ClaimSteps.verifying)
    expect(resumed.verification.sessionId).toBe('s1')
    const verified = ClaimStateDtoSchema.parse(
      fixtures.claimState({ status: 'verified', verification: { status: 'verified' } }),
    )
    expect(stateFromClaimDto(verified, flags).step).toBe(ClaimSteps.complete)
  })

  it('shows the §48 screen for a duplicate raised outside a verification result', () => {
    const state = duplicateState('start_group', flags)
    expect(state.step).toBe(ClaimSteps.duplicate)
    expect(state.failure?.kind).toBe('duplicate')
  })

  it('stores and reads the choices a Visitor made before signing in', () => {
    const store = createMemoryStorage()
    const state = claimReducer(
      claimReducer(stateFromPending(null, flags), { type: 'chooseStart' }),
      { type: 'labelSet', label: '  Weekend Crew ' },
    )
    writePendingClaim(store, pendingFromState(state, 123))
    const pending = readPendingClaim(store)
    expect(pending).toEqual({
      intent: 'start_group',
      groupLabel: 'Weekend Crew',
      inviteToken: null,
      startedAt: 123,
    })
    expect(stateFromPending(pending, flags).step).toBe(ClaimSteps.credential)
    expect(readPendingClaim(createMemoryStorage({ 'earth.claim.pending': '{bad' }))).toBeNull()
  })

  it('keeps the completion for the welcome screen', () => {
    const store = createMemoryStorage()
    const completion = {
      humanId: '11111111-1111-4111-8111-111111111111' as never,
      groupId: '22222222-2222-4222-8222-222222222222' as never,
      conversationId: '33333333-3333-4333-8333-333333333333' as never,
    }
    writeCompletion(store, completion, 'join_group')
    expect(readCompletion(store)).toEqual({ ...completion, intent: 'join_group' })
    expect(destinationAfterClaim(completion)).toBe('/chats/33333333-3333-4333-8333-333333333333')
  })
})

describe('verification helpers', () => {
  it('eases polling from 1.5 s to 5 s', () => {
    expect(pollDelayMs(0)).toBe(1_500)
    expect(pollDelayMs(3)).toBe(3_000)
    expect(pollDelayMs(50)).toBe(5_000)
  })

  it('narrows the server failure kind and drops unknown values', () => {
    expect(
      outcomeFromResult({ sessionId: 's', status: 'review_required', failureKind: 'duplicate' }),
    ).toEqual({
      status: 'review_required',
      failureKind: 'duplicate',
    })
    expect(outcomeFromResult({ sessionId: 's', status: 'verified', failureKind: null })).toEqual({
      status: 'verified',
      failureKind: null,
    })
    expect(
      outcomeFromResult({ sessionId: 's', status: 'rejected', failureKind: 'weird' }).failureKind,
    ).toBeNull()
  })

  it('only reports decided outcomes as verification failures', () => {
    expect(failureOutcomeFor('review_required')).toBe('review_required')
    expect(failureOutcomeFor('rejected')).toBe('rejected')
    expect(failureOutcomeFor('unverified')).toBeNull()
    expect(failureOutcomeFor('verified')).toBeNull()
  })
})

describe('parseInviteToken', () => {
  it('accepts a raw token or any URL with /g/<token>', () => {
    expect(parseInviteToken('abc_DEF-123')).toBe('abc_DEF-123')
    expect(parseInviteToken('https://earth.social/g/abc123?x=1')).toBe('abc123')
    expect(parseInviteToken(' http://localhost:3000/g/t%2Fk ')).toBe('t/k')
    expect(parseInviteToken('')).toBeNull()
    expect(parseInviteToken('not a token!')).toBeNull()
    expect(parseInviteToken('https://earth.social/g/')).toBeNull()
  })
})

describe('copy helpers', () => {
  it('titles each step from the canonical copy', () => {
    expect(claimStepTitle(stateFromPending(null, flags))).toBe('Earth starts with your people.')
    const start = claimReducer(stateFromPending(null, flags), { type: 'chooseStart' })
    expect(claimStepTitle(start)).toBe('Optional: Give this group a name')
    expect(claimStepTitle(claimReducer(start, { type: 'labelSet', label: null }))).toBe(
      'Claim your place to start the group.',
    )
    expect(
      claimStepTitle(
        claimReducer(stateFromPending(null, flags), { type: 'chooseJoin', inviteToken: 't' }),
      ),
    ).toBe('Join them')
  })

  it('builds the §49 CTA', () => {
    expect(enterGroupLabel('Weekend Crew', 'Enter your group')).toBe('Enter Weekend Crew')
    expect(enterGroupLabel(null, 'Enter your group')).toBe('Enter your group')
    expect(enterGroupLabel('  ', 'Enter your group')).toBe('Enter your group')
  })
})
