import { EarthError } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { CRON_SECRET_HEADER, constantTimeEqual, requireCronSecret } from './cron'
import { TEST_CRON_SECRET, createFakeDeps, fakeRequest } from './test/fakes'

describe('constantTimeEqual', () => {
  it('compares equal and different strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'ab')).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
    expect(constantTimeEqual('', 'a')).toBe(false)
    expect(constantTimeEqual('ünïcode', 'ünïcode')).toBe(true)
    expect(constantTimeEqual('ünïcode', 'unicode')).toBe(false)
  })

  it('inspects every byte regardless of where the first difference is', () => {
    // Same-length inputs differing only in the last byte must still be rejected.
    expect(constantTimeEqual('a'.repeat(64), `${'a'.repeat(63)}b`)).toBe(false)
    expect(constantTimeEqual(`b${'a'.repeat(63)}`, 'a'.repeat(64))).toBe(false)
  })
})

describe('requireCronSecret', () => {
  it('accepts the configured secret', () => {
    const { deps } = createFakeDeps()
    const req = fakeRequest({
      url: '/api/internal/rooms/sweep',
      headers: { [CRON_SECRET_HEADER]: TEST_CRON_SECRET },
    })
    expect(() => requireCronSecret(deps, req)).not.toThrow()
  })

  it('rejects a missing header with not_authenticated', () => {
    const { deps } = createFakeDeps()
    try {
      requireCronSecret(deps, fakeRequest({ url: '/x' }))
      throw new Error('should have thrown')
    } catch (err) {
      expect((err as EarthError).code).toBe('not_authenticated')
    }
  })

  it('rejects a wrong or empty secret with forbidden', () => {
    const { deps } = createFakeDeps()
    for (const value of ['nope', `${TEST_CRON_SECRET}x`, TEST_CRON_SECRET.slice(1)]) {
      try {
        requireCronSecret(
          deps,
          fakeRequest({ url: '/x', headers: { [CRON_SECRET_HEADER]: value } }),
        )
        throw new Error('should have thrown')
      } catch (err) {
        expect((err as EarthError).code).toBe('forbidden')
      }
    }
  })

  it('never matches when no secret is configured', () => {
    const { deps } = createFakeDeps({ cronSecret: '' })
    expect(() =>
      requireCronSecret(
        deps,
        fakeRequest({ url: '/x', headers: { [CRON_SECRET_HEADER]: 'anything' } }),
      ),
    ).toThrow(EarthError)
  })
})
