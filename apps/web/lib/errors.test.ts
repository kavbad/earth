import { EARTH_ERROR_CODES, EarthError } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { TRANSIENT_ERROR_CODES, errorCode, isTransientFailure } from './errors'

describe('errorCode', () => {
  it('reads an EarthError code and calls everything else internal', () => {
    expect(errorCode(new EarthError('invite_expired'))).toBe('invite_expired')
    expect(errorCode(new TypeError('Failed to fetch'))).toBe('internal')
    expect(errorCode('nope')).toBe('internal')
  })
})

describe('isTransientFailure (spec §107, §110)', () => {
  it('treats a lost connection or a throttle as worth retrying', () => {
    for (const code of TRANSIENT_ERROR_CODES) expect(isTransientFailure(code)).toBe(true)
    // A network failure is not an EarthError, so it arrives as `internal`.
    expect(isTransientFailure(errorCode(new TypeError('Failed to fetch')))).toBe(true)
  })

  it('treats a settled answer about the thing asked for as permanent', () => {
    const permanent = EARTH_ERROR_CODES.filter(
      (code) => !(TRANSIENT_ERROR_CODES as readonly string[]).includes(code),
    )
    expect(permanent.length).toBeGreaterThan(0)
    for (const code of permanent) expect(isTransientFailure(code)).toBe(false)
    expect(isTransientFailure('invite_expired')).toBe(false)
    expect(isTransientFailure('room_ended')).toBe(false)
    expect(isTransientFailure('not_visible')).toBe(false)
  })
})
