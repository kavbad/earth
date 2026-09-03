import { describe, expect, it } from 'vitest'

import {
  EARTH_ERROR_CODES,
  EARTH_ERROR_HTTP_STATUS,
  EarthError,
  httpStatusForErrorCode,
  isEarthError,
  isEarthErrorCode,
  parseEarthError,
} from './errors'

describe('EARTH_ERROR_CODES', () => {
  it('has no duplicates, is snake_case and always includes internal', () => {
    expect(new Set(EARTH_ERROR_CODES).size).toBe(EARTH_ERROR_CODES.length)
    for (const code of EARTH_ERROR_CODES) expect(code).toMatch(/^[a-z][a-z_]*$/)
    expect(EARTH_ERROR_CODES).toContain('internal')
  })

  it('maps every code to an HTTP status', () => {
    for (const code of EARTH_ERROR_CODES) {
      expect(EARTH_ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400)
    }
    expect(httpStatusForErrorCode('not_authenticated')).toBe(401)
    expect(httpStatusForErrorCode('rate_limited')).toBe(429)
    expect(httpStatusForErrorCode('internal')).toBe(500)
  })
})

describe('EarthError', () => {
  it('is an Error carrying code and details', () => {
    const error = new EarthError('blocked', { details: { humanId: 'x' } })
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('EarthError')
    expect(error.code).toBe('blocked')
    expect(error.message).toBe('blocked')
    expect(error.details).toEqual({ humanId: 'x' })
    expect(error.toJSON()).toEqual({ code: 'blocked', details: { humanId: 'x' } })
    expect(new EarthError('internal').toJSON()).toEqual({ code: 'internal' })
    expect(isEarthError(error)).toBe(true)
    expect(isEarthError(new Error('blocked'))).toBe(false)
    expect(isEarthErrorCode('blocked')).toBe(true)
    expect(isEarthErrorCode('BLOCKED')).toBe(false)
  })
})

describe('parseEarthError', () => {
  it('returns EarthError instances unchanged', () => {
    const error = new EarthError('not_a_member')
    expect(parseEarthError(error)).toBe(error)
  })

  it('maps a PostgREST error whose message is a known code', () => {
    const parsed = parseEarthError({
      message: 'not_a_member',
      code: 'P0001',
      details: null,
      hint: null,
    })
    expect(parsed.code).toBe('not_a_member')
    expect(parsed.details).toBeUndefined()
  })

  it('keeps details from a Postgres error', () => {
    const parsed = parseEarthError({
      message: 'rate_limited',
      code: 'P0001',
      details: 'retry in 30s',
    })
    expect(parsed.code).toBe('rate_limited')
    expect(parsed.details).toEqual({ detail: 'retry in 30s' })
  })

  it('maps a plain Error whose message equals a code (with surrounding whitespace)', () => {
    expect(parseEarthError(new Error(' consent_required ')).code).toBe('consent_required')
  })

  it('maps server-tier JSON bodies', () => {
    expect(parseEarthError({ error: { code: 'forbidden' } }).code).toBe('forbidden')
    const withDetails = parseEarthError({
      error: { code: 'invalid_input', details: { field: 'q' } },
    })
    expect(withDetails.code).toBe('invalid_input')
    expect(withDetails.details).toEqual({ field: 'q' })
    expect(parseEarthError({ code: 'room_ended' }).code).toBe('room_ended')
  })

  it('maps bare strings', () => {
    expect(parseEarthError('handle_taken').code).toBe('handle_taken')
    expect(parseEarthError('something else').code).toBe('internal')
  })

  it('falls back to internal for unknown values and keeps the cause', () => {
    const boom = new Error('connection refused')
    const parsed = parseEarthError(boom)
    expect(parsed.code).toBe('internal')
    expect(parsed.cause).toBe(boom)
    expect(parsed.message).toBe('connection refused')
    expect(parseEarthError(null).code).toBe('internal')
    expect(parseEarthError(undefined).code).toBe('internal')
    expect(parseEarthError(42).code).toBe('internal')
    expect(parseEarthError({ message: 'NOT_A_MEMBER' }).code).toBe('internal')
    expect(parseEarthError({ code: '23505', message: 'duplicate key' }).code).toBe('internal')
  })
})
