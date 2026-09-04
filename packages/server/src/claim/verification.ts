/**
 * Human verification routes (ARCHITECTURE §6; spec §15, §48, §77, §78, §111; DB_API §1).
 *
 * - `POST /api/claim/verification/start`: `claim_verification_begin(provider)` as the caller, then
 *   `provider.startVerification(...)`. The session id is recorded as `human_passes.provider_reference`
 *   (status stays `verifying`) so `claim_get().verification.sessionId` names the caller's session;
 *   that is how the result route proves a session belongs to the caller without a session store.
 *   In mock mode the result is fetched and recorded immediately.
 * - `GET /api/claim/verification/:sessionId`: ownership check, `provider.getVerificationResult`,
 *   record through the service RPC `human_pass_record_result`, answer `{ status, failureKind }`.
 * - `POST /api/claim/verification/webhook`: `provider.verifyWebhook` (signature), then record.
 *
 * Recording is idempotent (the RPC updates the same Human Pass). Provider metadata goes to
 * `private.human_pass_metadata` through the RPC and is never part of a response (spec §19, §78).
 */
import {
  type ClaimStateDto,
  ClaimStateDtoSchema,
  EarthError,
  type HumanId,
  HumanIdSchema,
  type HumanPassStatus,
  HumanPassStatusSchema,
  PushPlatformSchema,
  UrlSchema,
  type VerificationSessionDto,
  VerificationSessionDtoSchema,
  isUuid,
} from '@earth/domain'
import { z } from 'zod'

import type { ServerDeps } from '../deps'
import {
  AnyRpcResultSchema,
  type EarthRequest,
  type EarthResponse,
  HTTP_STATUS,
  error,
  ok,
  parseOutput,
  readBody,
  requireBearer,
  rpc,
  rpcAdmin,
} from '../http'
import {
  MockVerificationOutcomeSchema,
  type VerificationFailureKind,
  VerificationFailureKindSchema,
  type VerificationResult,
  type VerificationSession,
  VerificationModes,
  failureKindForResult,
  humanPassStatusForResult,
} from '../verification/provider-types'

export const CLAIM_VERIFICATION_BEGIN_RPC = 'claim_verification_begin' as const
export const CLAIM_GET_RPC = 'claim_get' as const
export const HUMAN_PASS_RECORD_RESULT_RPC = 'human_pass_record_result' as const

/** Header a vendor puts its signature in (the `@earth/auth` vendor adapter reads `x-signature`). */
export const VERIFICATION_SIGNATURE_HEADERS = [
  'x-signature',
  'x-webhook-signature',
  'signature',
] as const

export const VERIFICATION_LOG = {
  started: 'verification.started',
  recorded: 'verification.recorded',
  webhookUnmapped: 'verification.webhook_unmapped',
} as const

const DEFAULT_LOCALE = 'en-US'

export const VerificationStartInputSchema = z.object({
  locale: z.string().trim().min(2).max(35).default(DEFAULT_LOCALE),
  platform: PushPlatformSchema.default('web'),
  returnUrl: UrlSchema.optional(),
  /** Mock outcome selector; real providers ignore it. */
  hint: MockVerificationOutcomeSchema.optional(),
})
export type VerificationStartInput = z.infer<typeof VerificationStartInputSchema>

/** `claim_verification_begin` result (`{ humanPassId }`, DB_API §1; `status`/`humanId` when present). */
export const ClaimVerificationBeginDtoSchema = z.object({
  humanPassId: z.string().min(1),
  status: HumanPassStatusSchema.optional(),
  humanId: HumanIdSchema.optional(),
})
export type ClaimVerificationBeginDto = z.infer<typeof ClaimVerificationBeginDtoSchema>

/** `GET /api/claim/verification/:sessionId` result — never provider metadata. */
export const VerificationResultDtoSchema = z.object({
  sessionId: z.string().min(1),
  status: HumanPassStatusSchema,
  failureKind: VerificationFailureKindSchema.nullable(),
})
export type VerificationResultDto = z.infer<typeof VerificationResultDtoSchema>

export interface RecordedVerification {
  readonly status: HumanPassStatus
  readonly failureKind: VerificationFailureKind | null
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/** Marks the pass `verifying` with the session id as `provider_reference` (ownership anchor). */
export async function recordVerificationSession(
  deps: ServerDeps,
  humanId: HumanId,
  session: VerificationSession,
): Promise<void> {
  await rpcAdmin(
    deps,
    HUMAN_PASS_RECORD_RESULT_RPC,
    {
      human_id: humanId,
      status: 'verifying' satisfies HumanPassStatus,
      risk_level: null,
      provider: deps.verification.kind,
      provider_reference: session.sessionId,
      metadata: {
        sessionId: session.sessionId,
        provider: session.provider,
        mode: session.mode,
        expiresAt: session.expiresAt,
        startedAt: deps.now().toISOString(),
      },
      duplicate_of_human_id: null,
    },
    AnyRpcResultSchema,
  )
}

/**
 * Records a provider result for a Human through `human_pass_record_result`. Idempotent: recording
 * the same session twice updates the same row. `provider_reference` stays the session id so the
 * ownership check keeps working; the provider's own reference is kept in the private metadata.
 */
export async function recordVerificationResult(
  deps: ServerDeps,
  humanId: HumanId,
  sessionId: string,
  result: VerificationResult,
): Promise<RecordedVerification> {
  const status = humanPassStatusForResult(result)
  const failureKind = failureKindForResult(result)
  const duplicateOfHumanId =
    typeof result.duplicateOfHumanId === 'string' && isUuid(result.duplicateOfHumanId)
      ? result.duplicateOfHumanId
      : null
  await rpcAdmin(
    deps,
    HUMAN_PASS_RECORD_RESULT_RPC,
    {
      human_id: humanId,
      status,
      risk_level: result.riskLevel,
      provider: deps.verification.kind,
      provider_reference: sessionId,
      metadata: {
        ...result.metadata,
        sessionId,
        providerReference: result.providerReference,
        resultStatus: result.status,
        failureKind,
        recordedAt: deps.now().toISOString(),
      },
      duplicate_of_human_id: duplicateOfHumanId,
    },
    AnyRpcResultSchema,
  )
  deps.logger.info(VERIFICATION_LOG.recorded, {
    humanId,
    sessionId,
    status,
    failureKind,
    duplicate: duplicateOfHumanId !== null,
  })
  return { status, failureKind }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function claimStateFor(deps: ServerDeps, accessToken: string): Promise<ClaimStateDto> {
  return rpc(deps, accessToken, CLAIM_GET_RPC, {}, ClaimStateDtoSchema)
}

/** `POST /api/claim/verification/start`. */
export async function handleVerificationStart(
  deps: ServerDeps,
  req: EarthRequest,
): Promise<EarthResponse> {
  const accessToken = requireBearer(req)
  const input = await readBody(req, VerificationStartInputSchema)
  const begin = await rpc(
    deps,
    accessToken,
    CLAIM_VERIFICATION_BEGIN_RPC,
    { provider: deps.verification.kind },
    ClaimVerificationBeginDtoSchema,
  )

  let humanId = begin.humanId
  let existingSessionId: string | undefined
  if (humanId === undefined || begin.status === 'verified') {
    const claim = await claimStateFor(deps, accessToken)
    humanId = claim.humanId
    existingSessionId = claim.verification.sessionId
  }

  if (begin.status === 'verified') {
    // Already verified (the RPC returns early): nothing to start.
    const dto: VerificationSessionDto = parseOutput(
      VerificationSessionDtoSchema,
      {
        sessionId: existingSessionId ?? begin.humanPassId,
        status: 'verified' satisfies HumanPassStatus,
        providerUrl: null,
        expiresAt: null,
      },
      'VerificationSessionDto',
    )
    return ok(dto)
  }

  const session = await deps.verification.startVerification({
    humanId,
    humanPassId: begin.humanPassId,
    locale: input.locale,
    platform: input.platform,
    ...(input.returnUrl === undefined ? {} : { returnUrl: input.returnUrl }),
    ...(input.hint === undefined ? {} : { hint: input.hint }),
  })
  await recordVerificationSession(deps, humanId, session)
  deps.logger.info(VERIFICATION_LOG.started, {
    humanId,
    sessionId: session.sessionId,
    provider: session.provider,
    mode: session.mode,
  })

  let status: HumanPassStatus = 'verifying'
  if (session.mode === VerificationModes.mock) {
    const result = await deps.verification.getVerificationResult(session.sessionId)
    const recorded = await recordVerificationResult(deps, humanId, session.sessionId, result)
    status = recorded.status
  }

  const dto: VerificationSessionDto = parseOutput(
    VerificationSessionDtoSchema,
    {
      sessionId: session.sessionId,
      status,
      providerUrl: session.url ?? null,
      expiresAt: session.expiresAt,
    },
    'VerificationSessionDto',
  )
  return ok(dto)
}

/** `GET /api/claim/verification/:sessionId`. */
export async function handleVerificationResult(
  deps: ServerDeps,
  req: EarthRequest,
  sessionId: string,
): Promise<EarthResponse> {
  const accessToken = requireBearer(req)
  if (sessionId.trim() === '') {
    throw new EarthError('invalid_input', { details: { field: 'sessionId', reason: 'empty' } })
  }
  const claim = await claimStateFor(deps, accessToken)
  if (claim.verification.sessionId !== sessionId) {
    // Not this caller's session (or none started): indistinguishable from a missing one.
    throw new EarthError('not_visible', { details: { field: 'sessionId' } })
  }
  const result = await deps.verification.getVerificationResult(sessionId)
  const recorded = await recordVerificationResult(deps, claim.humanId, sessionId, result)
  const dto: VerificationResultDto = parseOutput(
    VerificationResultDtoSchema,
    { sessionId, status: recorded.status, failureKind: recorded.failureKind },
    'VerificationResultDto',
  )
  return ok(dto)
}

function signatureHeaderOf(req: EarthRequest): string | null {
  for (const name of VERIFICATION_SIGNATURE_HEADERS) {
    const value = req.headers.get(name)
    if (value !== null && value.trim() !== '') return value
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * The Human a vendor callback is about. The vendor adapter creates sessions with
 * `subject_id = humanId` and keeps the whole payload under `metadata.vendor`, so the id is read
 * back from there (`subject_id` / `subject`), or from a top-level `humanId` / `subjectId`.
 */
export function humanIdFromWebhookResult(result: VerificationResult): HumanId | null {
  const metadata = asRecord(result.metadata) ?? {}
  const vendor = asRecord(metadata['vendor']) ?? {}
  const candidates = [
    metadata['humanId'],
    metadata['subjectId'],
    vendor['subject_id'],
    vendor['subject'],
    vendor['subjectId'],
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && isUuid(candidate)) return candidate as HumanId
  }
  return null
}

export interface VerificationWebhookOutcome {
  readonly ok: boolean
  readonly recorded: boolean
  readonly sessionId?: string
  readonly reason?: string
}

/** `POST /api/claim/verification/webhook`. */
export async function handleVerificationWebhook(
  deps: ServerDeps,
  req: EarthRequest,
): Promise<EarthResponse> {
  const verify = deps.verification.verifyWebhook
  if (verify === undefined) {
    return error(HTTP_STATUS.forbidden, 'feature_disabled', { reason: 'provider_has_no_webhook' })
  }
  const rawBody = await req.text()
  const event = await verify.call(deps.verification, rawBody, signatureHeaderOf(req))
  const humanId = humanIdFromWebhookResult(event.result)
  if (humanId === null) {
    deps.logger.warn(VERIFICATION_LOG.webhookUnmapped, { sessionId: event.sessionId })
    const body: VerificationWebhookOutcome = {
      ok: true,
      recorded: false,
      sessionId: event.sessionId,
      reason: 'human_not_identified',
    }
    return ok(body, HTTP_STATUS.accepted)
  }
  await recordVerificationResult(deps, humanId, event.sessionId, event.result)
  const body: VerificationWebhookOutcome = { ok: true, recorded: true, sessionId: event.sessionId }
  return ok(body)
}
