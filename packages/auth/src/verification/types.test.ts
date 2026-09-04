import { describe, expect, it } from 'vitest'

import { APP_ENVS, type AppEnv } from '@earth/config'
import { HUMAN_PASS_STATUS, type HumanId } from '@earth/domain'

import {
  CLIENT_VERIFICATION_OUTCOME_KEYS,
  MOCK_ALLOWED_APP_ENVS,
  VERIFICATION_PRIVATE_RESULT_KEYS,
  VERIFICATION_STATUSES,
  type VerificationPrivateResultKey,
  type VerificationResult,
  failureKindForHumanPassStatus,
  failureKindForResult,
  humanPassStatusForResult,
  isMockAllowedAppEnv,
  toClientVerificationOutcome,
} from './types'

const OTHER_HUMAN = '22222222-2222-4222-8222-222222222222' as HumanId

function result(overrides: Partial<VerificationResult>): VerificationResult {
  return {
    status: 'verified',
    riskLevel: 'low',
    providerReference: 'ref',
    duplicateOfHumanId: null,
    metadata: { provider: 'vendor', vendor: { face_template_id: 'ft_secret' } },
    ...overrides,
  }
}

describe('failureKindForResult', () => {
  it.each([
    ['verified', null],
    ['pending', null],
    ['error', 'technical'],
    ['review_required', 'inconclusive'],
    ['rejected', 'inconclusive'],
    ['inconclusive', 'inconclusive'],
  ] as const)('%s without a duplicate → %s', (status, kind) => {
    expect(failureKindForResult(result({ status }))).toBe(kind)
  })

  it('treats a named existing Human as a duplicate whatever the status says (spec §48, §128)', () => {
    for (const status of VERIFICATION_STATUSES) {
      expect(failureKindForResult(result({ status, duplicateOfHumanId: OTHER_HUMAN }))).toBe(
        'duplicate',
      )
    }
    // ... even over an explicit, contradicting kind from an adapter.
    expect(
      failureKindForResult(
        result({ status: 'error', failureKind: 'technical', duplicateOfHumanId: OTHER_HUMAN }),
      ),
    ).toBe('duplicate')
  })

  it('lets an explicit failure kind win over the status otherwise', () => {
    expect(failureKindForResult(result({ status: 'rejected', failureKind: 'technical' }))).toBe(
      'technical',
    )
    expect(
      failureKindForResult(result({ status: 'review_required', failureKind: 'duplicate' })),
    ).toBe('duplicate')
  })
})

describe('humanPassStatusForResult', () => {
  it.each([
    ['verified', 'verified'],
    ['pending', 'verifying'],
    ['error', 'unverified'],
    ['review_required', 'review_required'],
    ['rejected', 'rejected'],
    ['inconclusive', 'review_required'],
  ] as const)('%s → %s', (status, passStatus) => {
    expect(humanPassStatusForResult({ status })).toBe(passStatus)
  })

  it('never records a duplicate as verified or verifying', () => {
    expect(
      humanPassStatusForResult(result({ status: 'verified', duplicateOfHumanId: OTHER_HUMAN })),
    ).toBe('review_required')
    expect(
      humanPassStatusForResult(result({ status: 'pending', duplicateOfHumanId: OTHER_HUMAN })),
    ).toBe('review_required')
    expect(
      humanPassStatusForResult(result({ status: 'review_required', failureKind: 'duplicate' })),
    ).toBe('review_required')
  })
})

describe('toClientVerificationOutcome', () => {
  it('projects exactly status and failureKind — no metadata, risk, reference or matched Human', () => {
    const full = result({
      status: 'review_required',
      riskLevel: 'high',
      duplicateOfHumanId: OTHER_HUMAN,
      failureKind: 'duplicate',
    })
    const outcome = toClientVerificationOutcome(full)
    expect(outcome).toEqual({ status: 'review_required', failureKind: 'duplicate' })
    expect(Object.keys(outcome).sort()).toEqual([...CLIENT_VERIFICATION_OUTCOME_KEYS].sort())
    for (const key of VERIFICATION_PRIVATE_RESULT_KEYS) {
      expect(key in outcome).toBe(false)
    }
    const serialized = JSON.stringify(outcome)
    expect(serialized).not.toContain(OTHER_HUMAN)
    expect(serialized).not.toContain('ft_secret')
    expect(serialized).not.toContain('high')
    expect(serialized).not.toContain('ref')
  })

  it('classifies every result field as either private or client-facing (compile-time)', () => {
    type Leftover = Exclude<
      keyof VerificationResult,
      VerificationPrivateResultKey | (typeof CLIENT_VERIFICATION_OUTCOME_KEYS)[number]
    >
    // Fails to compile if a new VerificationResult field is added without classifying it.
    const leftover: Record<Leftover, never> = {}
    expect(leftover).toEqual({})
    expect(
      [...VERIFICATION_PRIVATE_RESULT_KEYS, ...CLIENT_VERIFICATION_OUTCOME_KEYS].sort(),
    ).toEqual(Object.keys(result({})).concat('failureKind').sort())
  })

  it('maps the mock and manual outcomes the client will see', () => {
    expect(toClientVerificationOutcome(result({ status: 'verified' }))).toEqual({
      status: 'verified',
      failureKind: null,
    })
    expect(toClientVerificationOutcome(result({ status: 'pending' }))).toEqual({
      status: 'verifying',
      failureKind: null,
    })
    expect(toClientVerificationOutcome(result({ status: 'error' }))).toEqual({
      status: 'unverified',
      failureKind: 'technical',
    })
  })
})

describe('failureKindForHumanPassStatus', () => {
  it('covers every Human Pass status', () => {
    const table: Record<(typeof HUMAN_PASS_STATUS)[number], string | null> = {
      unverified: 'technical',
      verifying: null,
      verified: null,
      review_required: 'inconclusive',
      rejected: 'inconclusive',
    }
    for (const status of HUMAN_PASS_STATUS) {
      expect(failureKindForHumanPassStatus(status)).toBe(table[status])
    }
  })
})

describe('isMockAllowedAppEnv', () => {
  it('allows only development and preview; everything else fails closed', () => {
    expect(MOCK_ALLOWED_APP_ENVS).toEqual(['development', 'preview'])
    for (const env of APP_ENVS) {
      expect(isMockAllowedAppEnv(env)).toBe(env !== 'production')
    }
    for (const bad of [
      'prod',
      'PRODUCTION',
      'Development',
      '',
      ' development',
      undefined,
      null,
      0,
    ]) {
      expect(isMockAllowedAppEnv(bad as unknown as AppEnv)).toBe(false)
    }
  })
})
