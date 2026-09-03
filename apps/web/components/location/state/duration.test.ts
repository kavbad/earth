import { LOCATION_SHARE_MAX_MINUTES, LOCATION_SHARE_MIN_MINUTES } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  CUSTOM_DURATION_MINUTES,
  ONE_HOUR_MINUTES,
  TONIGHT_END_HOUR,
  clampMinutes,
  durationMinutesFor,
  expiresAtFor,
  formatClock,
  formatMinutes,
  tonightMinutes,
  validateDurationMinutes,
} from './duration'

const at = (hour: number, minute = 0): Date => {
  const date = new Date(2026, 8, 3, hour, minute, 0, 0)
  return date
}

describe('share durations (spec §75)', () => {
  it('offers 1 hour as exactly sixty minutes', () => {
    expect(ONE_HOUR_MINUTES).toBe(60)
    expect(durationMinutesFor({ kind: 'oneHour', customMinutes: 999 }, at(12))).toBe(60)
  })

  it('"Tonight" runs until the next early morning and never past the maximum', () => {
    expect(tonightMinutes(at(20))).toBe(6 * 60)
    expect(tonightMinutes(at(1, 30))).toBe(30)
    expect(tonightMinutes(at(2))).toBe(LOCATION_SHARE_MAX_MINUTES)
    expect(tonightMinutes(at(TONIGHT_END_HOUR, 0))).toBeLessThanOrEqual(LOCATION_SHARE_MAX_MINUTES)
    expect(tonightMinutes(at(1, 59))).toBeGreaterThanOrEqual(LOCATION_SHARE_MIN_MINUTES)
  })

  it('never yields forever or nothing: custom values are clamped to the domain bounds', () => {
    expect(clampMinutes(0)).toBe(LOCATION_SHARE_MIN_MINUTES)
    expect(clampMinutes(10_000)).toBe(LOCATION_SHARE_MAX_MINUTES)
    expect(durationMinutesFor({ kind: 'custom', customMinutes: 90 }, at(9))).toBe(90)
    expect(
      CUSTOM_DURATION_MINUTES.every(
        (m) => m >= LOCATION_SHARE_MIN_MINUTES && m <= LOCATION_SHARE_MAX_MINUTES,
      ),
    ).toBe(true)
    expect(CUSTOM_DURATION_MINUTES.length).toBeGreaterThan(0)
  })

  it('validates a typed value against the exact rule', () => {
    expect(validateDurationMinutes(60)).toEqual({ ok: true, minutes: 60 })
    expect(validateDurationMinutes(LOCATION_SHARE_MIN_MINUTES - 1)).toEqual({
      ok: false,
      reason: 'too_short',
    })
    expect(validateDurationMinutes(LOCATION_SHARE_MAX_MINUTES + 1)).toEqual({
      ok: false,
      reason: 'too_long',
    })
    expect(validateDurationMinutes(Number.NaN)).toEqual({ ok: false, reason: 'not_a_number' })
    expect(validateDurationMinutes(1.5)).toEqual({ ok: false, reason: 'not_a_number' })
  })

  it('formats lengths and expiry', () => {
    expect(formatMinutes(45)).toBe('45 min')
    expect(formatMinutes(60)).toBe('1 hour')
    expect(formatMinutes(150)).toBe('2 hours 30 min')
    const now = new Date('2026-09-03T18:00:00.000Z')
    expect(expiresAtFor(now, 90).toISOString()).toBe('2026-09-03T19:30:00.000Z')
    expect(formatClock(expiresAtFor(now, 90), { utc: true })).toBe('7:30 PM')
  })
})
