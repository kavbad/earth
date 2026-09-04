import { describe, expect, it } from 'vitest'

import * as auth from './index'

describe('@earth/auth', () => {
  it('exposes its package name', () => {
    expect(auth.PACKAGE_NAME).toBe('@earth/auth')
  })

  it('exports the verification, session and claim modules', () => {
    expect(typeof auth.createVerificationProvider).toBe('function')
    expect(typeof auth.MockHumanVerificationProvider).toBe('function')
    expect(typeof auth.ManualReviewVerificationProvider).toBe('function')
    expect(typeof auth.VendorHumanVerificationProvider).toBe('function')
    expect(typeof auth.createSupabaseSession).toBe('function')
    expect(typeof auth.roleKindFromSession).toBe('function')
    expect(typeof auth.nextStep).toBe('function')
    expect(typeof auth.initialClaimState).toBe('function')
    expect(auth.VERIFICATION_FAILURE_KINDS).toEqual(['technical', 'inconclusive', 'duplicate'])
  })
})
