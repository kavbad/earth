import { CLAIM_FLAG_KEY, type ClaimFlags, ClaimSteps, initialClaimState } from '@earth/auth'
import { describe, expect, it } from 'vitest'

import { ROUTES } from '../routes'
import { createMemoryStorage } from '../storage'
import {
  claimRedirectFor,
  claimReducer,
  clearPendingClaim,
  destinationAfterClaim,
  duplicateState,
  enterGroupLabel,
  failureOutcomeFor,
  outcomeFromResult,
  parseInviteToken,
  pendingFromState,
  pollDelayMs,
  readPendingClaim,
  routeAfterAdvance,
  routeForStep,
  stateFromPending,
  stepForPathname,
  writePendingClaim,
} from './flow'

const flags: ClaimFlags = { [CLAIM_FLAG_KEY]: true }

describe('routes per step', () => {
  it('maps every step to a claim screen and back', () => {
    expect(routeForStep(ClaimSteps.gate)).toBe(ROUTES.claim)
    expect(routeForStep(ClaimSteps.group_label)).toBe(ROUTES.claimStart)
    expect(routeForStep(ClaimSteps.credential)).toBe(ROUTES.claimCredential)
    expect(routeForStep(ClaimSteps.identity)).toBe(ROUTES.claimIdentity)
    expect(routeForStep(ClaimSteps.verifying)).toBe(ROUTES.claimHuman)
    expect(routeForStep(ClaimSteps.done)).toBe(ROUTES.welcome)
    expect(stepForPathname(ROUTES.claimJoin)).toBe(ClaimSteps.credential)
    expect(stepForPathname('/home')).toBeNull()
  })

  it('never lets a screen skip ahead or fall back past the credential', () => {
    const gate = stateFromPending(null, flags)
    expect(claimRedirectFor(gate, ROUTES.claimIdentity)).toBe(ROUTES.claim)
    expect(claimRedirectFor(gate, ROUTES.claim)).toBeNull()
    expect(claimRedirectFor(gate, '/home')).toBeNull()
    const identity = initialClaimState({ flags, intent: 'start_group', authenticated: true })
    expect(identity.step).toBe(ClaimSteps.identity)
    expect(claimRedirectFor(identity, ROUTES.claim)).toBe(ROUTES.claimIdentity)
    expect(claimRedirectFor(identity, ROUTES.claimIdentity)).toBeNull()
  })

  it('advances to the next screen only when the step rank grew', () => {
    const gate = stateFromPending(null, flags)
    const label = claimReducer(gate, { type: 'chooseStart' })
    expect(routeAfterAdvance(gate, label)).toBe(ROUTES.claimStart)
    const credential = claimReducer(label, { type: 'labelSet', label: 'Weekend Crew' })
    expect(routeAfterAdvance(label, credential)).toBe(ROUTES.claimCredential)
    expect(routeAfterAdvance(credential, credential)).toBeNull()
  })
})

describe('pending claim on the device', () => {
  it('round-trips the choices and clears them', async () => {
    const store = createMemoryStorage()
    const state = claimReducer(stateFromPending(null, flags), {
      type: 'chooseJoin',
      inviteToken: 'tok',
    })
    await writePendingClaim(store, pendingFromState(state, 42))
    expect(await readPendingClaim(store)).toEqual({
      intent: 'join_group',
      groupLabel: null,
      inviteToken: 'tok',
      startedAt: 42,
    })
    await clearPendingClaim(store)
    expect(await readPendingClaim(store)).toBeNull()
  })

  it('resumes the machine from stored choices', () => {
    const state = stateFromPending(
      { intent: 'join_group', groupLabel: null, inviteToken: 'tok', startedAt: 1 },
      flags,
    )
    expect(state.step).toBe(ClaimSteps.credential)
    expect(state.inviteToken).toBe('tok')
  })
})

describe('verification helpers', () => {
  it('eases the poll and maps results', () => {
    expect(pollDelayMs(0)).toBe(1_500)
    expect(pollDelayMs(100)).toBe(5_000)
    expect(outcomeFromResult({ sessionId: 's', status: 'verified', failureKind: null })).toEqual({
      status: 'verified',
      failureKind: null,
    })
    expect(
      outcomeFromResult({ sessionId: 's', status: 'unverified', failureKind: 'weird' }),
    ).toEqual({
      status: 'unverified',
      failureKind: null,
    })
    expect(failureOutcomeFor('rejected')).toBe('rejected')
    expect(failureOutcomeFor('verifying')).toBeNull()
  })

  it('describes a duplicate raised by the server', () => {
    const state = duplicateState('start_group', flags)
    expect(state.step).toBe(ClaimSteps.duplicate)
  })
})

describe('tokens, titles and the destination', () => {
  it('parses a raw token or a link', () => {
    expect(parseInviteToken(' abc_DEF-1 ')).toBe('abc_DEF-1')
    expect(parseInviteToken('https://earth.social/g/tok?x=1')).toBe('tok')
    expect(parseInviteToken('not a token!')).toBeNull()
    expect(parseInviteToken('')).toBeNull()
  })

  it('names the group or falls back, and lands in the conversation', () => {
    expect(enterGroupLabel('Weekend Crew', 'Enter your group')).toBe('Enter Weekend Crew')
    expect(enterGroupLabel('  ', 'Enter your group')).toBe('Enter your group')
    expect(destinationAfterClaim({ conversationId: 'c1' as never })).toBe('/chats/c1')
  })
})
