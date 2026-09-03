import { describe, expect, it } from 'vitest'

import { type AppEnv } from '@earth/config'
import { type HumanId, isEarthError } from '@earth/domain'

import {
  MOCK_DUPLICATE_HUMAN_ID,
  MOCK_PROVIDER_REFERENCE_PREFIX,
  MockHumanVerificationProvider,
  mockResultFor,
} from './mock'
import {
  MOCK_VERIFICATION_OUTCOMES,
  type StartVerificationInput,
  VerificationConfigError,
  VerificationResultSchema,
  VerificationSessionSchema,
  failureKindForResult,
} from './types'

const HUMAN = '11111111-1111-4111-8111-111111111111' as HumanId
const OTHER_HUMAN = '22222222-2222-4222-8222-222222222222' as HumanId

const INPUT: StartVerificationInput = {
  humanId: HUMAN,
  humanPassId: 'pass-1',
  locale: 'en-US',
  platform: 'ios',
}

function fakeClock(start = Date.UTC(2026, 8, 3, 10, 0, 0)): {
  now: () => Date
  advance: (ms: number) => void
} {
  let current = start
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms
    },
  }
}

describe('MockHumanVerificationProvider', () => {
  it('refuses to exist in production', () => {
    expect(() => new MockHumanVerificationProvider({ appEnv: 'production' })).toThrow(
      VerificationConfigError,
    )
    expect(() => new MockHumanVerificationProvider({ appEnv: 'development' })).not.toThrow()
    expect(() => new MockHumanVerificationProvider({ appEnv: 'preview' })).not.toThrow()
  })

  it('fails closed for an unknown, mistyped or missing environment', () => {
    for (const bad of ['prod', 'PRODUCTION', 'Production', 'staging', '', undefined, null]) {
      const appEnv = bad as unknown as AppEnv
      expect(() => new MockHumanVerificationProvider({ appEnv })).toThrow(VerificationConfigError)
    }
    // A runtime object with no appEnv at all (the typed field is absent) is refused too.
    expect(() => new MockHumanVerificationProvider({} as unknown as { appEnv: AppEnv })).toThrow(
      VerificationConfigError,
    )
  })

  it('starts a mock-mode session with an expiry and verifies by default', async () => {
    const clock = fakeClock()
    const provider = new MockHumanVerificationProvider({ appEnv: 'development', now: clock.now })

    const session = await provider.startVerification(INPUT)
    expect(VerificationSessionSchema.parse(session)).toEqual(session)
    expect(session).toEqual({
      sessionId: 'mock-session-1',
      provider: 'mock',
      mode: 'mock',
      expiresAt: '2026-09-03T10:15:00.000Z',
    })

    const result = await provider.getVerificationResult(session.sessionId)
    expect(VerificationResultSchema.parse(result)).toEqual(result)
    expect(result.status).toBe('verified')
    expect(result.riskLevel).toBe('low')
    expect(result.providerReference).toBe(`${MOCK_PROVIDER_REFERENCE_PREFIX}mock-session-1`)
    expect(result.failureKind).toBeUndefined()
    expect(provider.getSession(session.sessionId)?.reads).toBe(1)
  })

  it.each([
    ['verified', 'verified', null],
    ['duplicate', 'review_required', 'duplicate'],
    ['inconclusive', 'inconclusive', 'inconclusive'],
    ['technical', 'error', 'technical'],
    ['rejected', 'rejected', 'inconclusive'],
  ] as const)('hint %s → status %s, failure kind %s', async (hint, status, failureKind) => {
    const provider = new MockHumanVerificationProvider({ appEnv: 'development' })
    const session = await provider.startVerification({ ...INPUT, hint })
    const result = await provider.getVerificationResult(session.sessionId)
    expect(result.status).toBe(status)
    expect(failureKindForResult(result)).toBe(failureKind)
    expect(result.failureKind ?? null).toBe(failureKind)
    expect(result.metadata).toMatchObject({ provider: 'mock', outcome: hint })
  })

  it('points a duplicate at the configured Human (or the stable default)', async () => {
    const withDefault = new MockHumanVerificationProvider({ appEnv: 'development' })
    const a = await withDefault.startVerification({ ...INPUT, hint: 'duplicate' })
    expect((await withDefault.getVerificationResult(a.sessionId)).duplicateOfHumanId).toBe(
      MOCK_DUPLICATE_HUMAN_ID,
    )

    const configured = new MockHumanVerificationProvider({
      appEnv: 'development',
      duplicateOfHumanId: OTHER_HUMAN,
    })
    const b = await configured.startVerification({ ...INPUT, hint: 'duplicate' })
    expect((await configured.getVerificationResult(b.sessionId)).duplicateOfHumanId).toBe(
      OTHER_HUMAN,
    )
  })

  it('honours the default outcome when the session has no hint', async () => {
    const provider = new MockHumanVerificationProvider({
      appEnv: 'development',
      defaultOutcome: 'inconclusive',
    })
    const session = await provider.startVerification(INPUT)
    expect((await provider.getVerificationResult(session.sessionId)).status).toBe('inconclusive')
  })

  it('reads pending until the artificial delay has elapsed on the injected clock', async () => {
    const clock = fakeClock()
    const provider = new MockHumanVerificationProvider({
      appEnv: 'development',
      now: clock.now,
      delayMs: 2_000,
    })
    const session = await provider.startVerification(INPUT)

    const early = await provider.getVerificationResult(session.sessionId)
    expect(early.status).toBe('pending')
    expect(early.failureKind).toBeUndefined()

    clock.advance(1_999)
    expect((await provider.getVerificationResult(session.sessionId)).status).toBe('pending')

    clock.advance(1)
    expect((await provider.getVerificationResult(session.sessionId)).status).toBe('verified')
    expect(provider.getSession(session.sessionId)?.reads).toBe(3)
  })

  it('rejects unknown sessions with invalid_input', async () => {
    const provider = new MockHumanVerificationProvider({ appEnv: 'development' })
    await expect(provider.getVerificationResult('nope')).rejects.toSatisfy(
      (error: unknown) => isEarthError(error) && error.code === 'invalid_input',
    )
  })

  it('keeps every session in memory with a custom id factory', async () => {
    let n = 0
    const provider = new MockHumanVerificationProvider({
      appEnv: 'development',
      nextSessionId: () => `s${(n += 1)}`,
    })
    await provider.startVerification(INPUT)
    await provider.startVerification({ ...INPUT, hint: 'technical' })
    expect(provider.listSessions().map((s) => [s.sessionId, s.outcome])).toEqual([
      ['s1', 'verified'],
      ['s2', 'technical'],
    ])
  })

  it('produces a schema-valid result for every outcome', () => {
    for (const outcome of MOCK_VERIFICATION_OUTCOMES) {
      const result = mockResultFor(outcome, 'ref', OTHER_HUMAN)
      expect(VerificationResultSchema.safeParse(result).success).toBe(true)
    }
  })
})
