/**
 * MockHumanVerificationProvider — development only (spec §15: "Development may use a mock
 * provider"; ARCHITECTURE §14: `mock` is refused when `APP_ENV=production`). Construction is
 * allow-listed on {@link MOCK_ALLOWED_APP_ENVS}: an unknown or missing environment fails closed.
 *
 * Deterministic: the outcome is chosen by `input.hint` (default `verified`), sessions live in
 * memory, and an optional artificial delay is measured with the injected clock so tests can
 * drive it without timers.
 */
import { type AppEnv, HumanVerificationProviders } from '@earth/config'
import { EarthError, type HumanId } from '@earth/domain'

import {
  type HumanVerificationProvider,
  MOCK_ALLOWED_APP_ENVS,
  type MockVerificationOutcome,
  MockVerificationOutcomes,
  type StartVerificationInput,
  VerificationConfigError,
  VerificationFailureKinds,
  VerificationModes,
  type VerificationResult,
  type VerificationSession,
  VerificationStatuses,
  isMockAllowedAppEnv,
} from './types'

export const MOCK_PROVIDER_REFERENCE_PREFIX = 'mock:' as const
export const MOCK_SESSION_TTL_MS = 15 * 60 * 1000
/** Stable id the `duplicate` outcome points at when the caller does not name one. */
export const MOCK_DUPLICATE_HUMAN_ID = '00000000-0000-4000-8000-00000000d0d0' as HumanId

export interface MockHumanVerificationProviderOptions {
  /** The running environment. Construction throws unless it is one of {@link MOCK_ALLOWED_APP_ENVS}. */
  readonly appEnv: AppEnv
  /** Outcome when the session carries no `hint`. Defaults to `verified`. */
  readonly defaultOutcome?: MockVerificationOutcome
  /** Results read `pending` until this much time has passed since the session started. */
  readonly delayMs?: number
  readonly sessionTtlMs?: number
  /** The Human a `duplicate` outcome points at. */
  readonly duplicateOfHumanId?: HumanId
  readonly now?: () => Date
  /** Session id factory; defaults to a counter so ids are stable within a process. */
  readonly nextSessionId?: () => string
}

export interface MockVerificationSessionRecord {
  readonly sessionId: string
  readonly input: StartVerificationInput
  readonly outcome: MockVerificationOutcome
  readonly startedAt: Date
  readonly expiresAt: Date
  /** How many times the result was read; lets tests assert polling. */
  reads: number
}

export class MockHumanVerificationProvider implements HumanVerificationProvider {
  readonly kind = HumanVerificationProviders.mock
  private readonly sessions = new Map<string, MockVerificationSessionRecord>()
  private readonly defaultOutcome: MockVerificationOutcome
  private readonly delayMs: number
  private readonly sessionTtlMs: number
  private readonly duplicateOfHumanId: HumanId
  private readonly now: () => Date
  private readonly nextSessionId: () => string
  private counter = 0

  constructor(options: MockHumanVerificationProviderOptions) {
    if (!isMockAllowedAppEnv(options.appEnv)) {
      throw new VerificationConfigError(
        HumanVerificationProviders.mock,
        `The mock Human verification provider verifies nobody and only runs when APP_ENV is one of ${MOCK_ALLOWED_APP_ENVS.join(', ')} (got ${JSON.stringify(options.appEnv)}); it must never run in production (spec §15, §77).`,
        // A value outside AppEnv still needs reporting; the error type is where it surfaces.
        options.appEnv,
      )
    }
    this.defaultOutcome = options.defaultOutcome ?? MockVerificationOutcomes.verified
    this.delayMs = Math.max(0, options.delayMs ?? 0)
    this.sessionTtlMs = options.sessionTtlMs ?? MOCK_SESSION_TTL_MS
    this.duplicateOfHumanId = options.duplicateOfHumanId ?? MOCK_DUPLICATE_HUMAN_ID
    this.now = options.now ?? (() => new Date())
    this.nextSessionId =
      options.nextSessionId ??
      (() => {
        this.counter += 1
        return `mock-session-${this.counter}`
      })
  }

  async startVerification(input: StartVerificationInput): Promise<VerificationSession> {
    const startedAt = this.now()
    const sessionId = this.nextSessionId()
    const record: MockVerificationSessionRecord = {
      sessionId,
      input,
      outcome: input.hint ?? this.defaultOutcome,
      startedAt,
      expiresAt: new Date(startedAt.getTime() + this.sessionTtlMs),
      reads: 0,
    }
    this.sessions.set(sessionId, record)
    return {
      sessionId,
      provider: this.kind,
      mode: VerificationModes.mock,
      expiresAt: record.expiresAt.toISOString(),
    }
  }

  async getVerificationResult(sessionId: string): Promise<VerificationResult> {
    const record = this.sessions.get(sessionId)
    if (record === undefined) {
      throw new EarthError('invalid_input', {
        details: { field: 'sessionId', reason: 'unknown_session' },
        message: `mock verification: unknown session ${sessionId}`,
      })
    }
    record.reads += 1
    const providerReference = `${MOCK_PROVIDER_REFERENCE_PREFIX}${sessionId}`
    const elapsed = this.now().getTime() - record.startedAt.getTime()
    if (elapsed < this.delayMs) {
      return {
        status: VerificationStatuses.pending,
        riskLevel: null,
        providerReference,
        metadata: { provider: this.kind, outcome: record.outcome, elapsedMs: elapsed },
      }
    }
    return mockResultFor(record.outcome, providerReference, this.duplicateOfHumanId)
  }

  /** The stored session, for tests and development tooling. */
  getSession(sessionId: string): MockVerificationSessionRecord | undefined {
    return this.sessions.get(sessionId)
  }

  listSessions(): readonly MockVerificationSessionRecord[] {
    return [...this.sessions.values()]
  }
}

/** The normalized result each mock outcome produces. */
export function mockResultFor(
  outcome: MockVerificationOutcome,
  providerReference: string,
  duplicateOfHumanId: HumanId,
): VerificationResult {
  const metadata = { provider: HumanVerificationProviders.mock, outcome }
  switch (outcome) {
    case 'verified':
      return {
        status: VerificationStatuses.verified,
        riskLevel: 'low',
        providerReference,
        duplicateOfHumanId: null,
        metadata,
      }
    case 'duplicate':
      return {
        status: VerificationStatuses.review_required,
        riskLevel: 'high',
        providerReference,
        duplicateOfHumanId,
        metadata,
        failureKind: VerificationFailureKinds.duplicate,
      }
    case 'inconclusive':
      return {
        status: VerificationStatuses.inconclusive,
        riskLevel: 'medium',
        providerReference,
        duplicateOfHumanId: null,
        metadata,
        failureKind: VerificationFailureKinds.inconclusive,
      }
    case 'technical':
      return {
        status: VerificationStatuses.error,
        riskLevel: null,
        providerReference,
        duplicateOfHumanId: null,
        metadata,
        failureKind: VerificationFailureKinds.technical,
      }
    case 'rejected':
      // A rejection still needs a person (spec §79): the copy offers help, never "failed".
      return {
        status: VerificationStatuses.rejected,
        riskLevel: 'high',
        providerReference,
        duplicateOfHumanId: null,
        metadata,
        failureKind: VerificationFailureKinds.inconclusive,
      }
    default: {
      const exhaustive: never = outcome
      throw new Error(`Unknown mock outcome: ${String(exhaustive)}`)
    }
  }
}
