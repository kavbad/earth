/**
 * VendorHumanVerificationProvider — a generic hosted-liveness adapter (spec §15 "liveness,
 * uniqueness/deduplication, device/account risk").
 *
 * Wire contract (any vendor is mapped onto it by configuration, never by editing the app):
 *
 * - `POST {baseUrl}/sessions` with `Authorization: Bearer <apiKey>` and a JSON body
 *   `{ subject_id, reference_id, locale, platform, return_url? }` → `{ id, url, expires_at }`.
 *   `subject_id` is the Human id (the vendor's dedupe key), `reference_id` the Human Pass id.
 * - `GET {baseUrl}/sessions/{id}` → `{ id, status, risk?, duplicate_of?, ... }`.
 * - Webhook: raw JSON body signed with HMAC-SHA256 under the shared secret; the signature
 *   header carries the hex digest, optionally as `sha256=<hex>` or `t=…,v1=<hex>`. The
 *   signature is checked in constant time before the body is parsed. A `t=` timestamp is not
 *   part of this contract's signed payload and is ignored; recording is idempotent, so a
 *   replayed callback re-records the same result.
 *
 * Every vendor payload is kept whole under `metadata.vendor`; the normalized fields are the
 * only thing that leaves this module (spec §19, §78).
 */
import { HumanVerificationProviders } from '@earth/config'
import { EarthError, type HumanId, UrlSchema, isUuid } from '@earth/domain'

import {
  type HumanVerificationProvider,
  type StartVerificationInput,
  VerificationConfigError,
  type VerificationFailureKind,
  VerificationFailureKinds,
  VerificationModes,
  type VerificationResult,
  type VerificationSession,
  type VerificationStatus,
  VerificationStatuses,
  type VerificationWebhookEvent,
  failureKindForResult,
  isRiskLevel,
} from './types'

// ---------------------------------------------------------------------------
// Injected platform surface (structural, so tests pass fakes)
// ---------------------------------------------------------------------------

export interface FetchResponseLike {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

export interface FetchRequestInit {
  readonly method?: string | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly body?: string | undefined
  readonly signal?: AbortSignal | undefined
}

export type FetchLike = (url: string, init?: FetchRequestInit) => Promise<FetchResponseLike>

/** The two WebCrypto calls the webhook check needs (`globalThis.crypto.subtle` satisfies it). */
export interface SubtleCryptoLike {
  importKey(
    format: 'raw',
    keyData: BufferSource,
    algorithm: HmacImportParams,
    extractable: boolean,
    keyUsages: readonly KeyUsage[],
  ): Promise<CryptoKey>
  sign(algorithm: AlgorithmIdentifier, key: CryptoKey, data: BufferSource): Promise<ArrayBuffer>
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export const VENDOR_SESSIONS_PATH = '/sessions' as const
export const VENDOR_SIGNATURE_HEADER = 'x-signature' as const
export const DEFAULT_VENDOR_TIMEOUT_MS = 10_000

/**
 * Vendor status → normalized status. Covers the common vocabularies of hosted liveness
 * products; `statusMap` in the options extends or overrides it per vendor.
 */
export const DEFAULT_VENDOR_STATUS_MAP: Readonly<Record<string, VerificationStatus>> = {
  created: 'pending',
  started: 'pending',
  pending: 'pending',
  processing: 'pending',
  in_progress: 'pending',
  submitted: 'pending',
  approved: 'verified',
  verified: 'verified',
  passed: 'verified',
  completed: 'verified',
  declined: 'rejected',
  rejected: 'rejected',
  denied: 'rejected',
  failed: 'rejected',
  review: 'review_required',
  needs_review: 'review_required',
  manual_review: 'review_required',
  in_review: 'review_required',
  duplicate: 'review_required',
  inconclusive: 'inconclusive',
  unable_to_verify: 'inconclusive',
  resubmission_requested: 'inconclusive',
  expired: 'error',
  abandoned: 'error',
  error: 'error',
}

/**
 * Vendor status words that mean "this person already has a Human", even when the vendor does
 * not say which one. They normalize to `review_required` with failure kind `duplicate` so the
 * §48 screen ("Recover your place", spec §111) is shown, never "Get help verifying".
 */
export const DEFAULT_VENDOR_DUPLICATE_STATUSES: readonly string[] = [
  'duplicate',
  'duplicate_detected',
  'duplicate_subject',
  'already_enrolled',
  'already_verified',
]

export interface VendorHumanVerificationProviderOptions {
  readonly baseUrl: string
  readonly apiKey: string
  /** Required to accept callbacks; `verifyWebhook` throws a config error without it. */
  readonly webhookSecret?: string | undefined
  readonly fetch: FetchLike
  readonly subtle?: SubtleCryptoLike
  readonly now?: () => Date
  readonly timeoutMs?: number
  /** Extra vendor status words, merged over {@link DEFAULT_VENDOR_STATUS_MAP}. */
  readonly statusMap?: Readonly<Record<string, VerificationStatus>>
  /** Extra vendor status words meaning "duplicate", merged over {@link DEFAULT_VENDOR_DUPLICATE_STATUSES}. */
  readonly duplicateStatuses?: readonly string[]
  /** Header the vendor puts its signature in. Defaults to {@link VENDOR_SIGNATURE_HEADER}. */
  readonly signatureHeaderName?: string
}

interface VendorSessionPayload {
  readonly id: string
  readonly url?: string | undefined
  readonly expires_at?: string | undefined
  readonly status?: string | undefined
  readonly risk?: string | undefined
  readonly risk_level?: string | undefined
  readonly duplicate_of?: string | undefined
  readonly duplicate_of_subject?: string | undefined
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class VendorHumanVerificationProvider implements HumanVerificationProvider {
  readonly kind = HumanVerificationProviders.vendor
  private readonly baseUrl: string
  private readonly apiKey: string
  private readonly webhookSecret: string | undefined
  private readonly fetch: FetchLike
  private readonly subtle: SubtleCryptoLike | undefined
  private readonly now: () => Date
  private readonly timeoutMs: number
  private readonly statusMap: Readonly<Record<string, VerificationStatus>>
  private readonly duplicateStatuses: ReadonlySet<string>
  readonly signatureHeaderName: string

  constructor(options: VendorHumanVerificationProviderOptions) {
    if (options.baseUrl.trim() === '' || options.apiKey.trim() === '') {
      throw new VerificationConfigError(
        HumanVerificationProviders.vendor,
        'The vendor Human verification provider needs HUMAN_VERIFICATION_VENDOR_URL and HUMAN_VERIFICATION_VENDOR_KEY.',
      )
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.webhookSecret = options.webhookSecret
    this.fetch = options.fetch
    this.subtle = options.subtle ?? globalThis.crypto?.subtle
    this.now = options.now ?? (() => new Date())
    this.timeoutMs = options.timeoutMs ?? DEFAULT_VENDOR_TIMEOUT_MS
    this.statusMap = { ...DEFAULT_VENDOR_STATUS_MAP, ...options.statusMap }
    this.duplicateStatuses = new Set(
      [...DEFAULT_VENDOR_DUPLICATE_STATUSES, ...(options.duplicateStatuses ?? [])].map((word) =>
        word.trim().toLowerCase(),
      ),
    )
    this.signatureHeaderName = options.signatureHeaderName ?? VENDOR_SIGNATURE_HEADER
  }

  async startVerification(input: StartVerificationInput): Promise<VerificationSession> {
    const response = await this.fetch(`${this.baseUrl}${VENDOR_SESSIONS_PATH}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        subject_id: input.humanId,
        reference_id: input.humanPassId,
        locale: input.locale,
        platform: input.platform,
        ...(input.returnUrl === undefined ? {} : { return_url: input.returnUrl }),
      }),
      signal: this.signal(),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new EarthError('internal', {
        details: { provider: this.kind, step: 'start', httpStatus: response.status },
        message: `vendor verification: session create failed with HTTP ${response.status}`,
      })
    }
    const payload = parseSessionPayload(text)
    // The hosted URL is handed to the client verbatim; only http(s) may leave here.
    const url = payload === null ? undefined : UrlSchema.safeParse(payload.url)
    if (payload === null || url === undefined || !url.success) {
      throw new EarthError('internal', {
        details: { provider: this.kind, step: 'start', reason: 'malformed_response' },
        message: 'vendor verification: session create returned an unexpected body',
      })
    }
    return {
      sessionId: payload.id,
      provider: this.kind,
      mode: VerificationModes.hosted_url,
      url: url.data,
      expiresAt: this.expiresAt(payload.expires_at),
    }
  }

  async getVerificationResult(sessionId: string): Promise<VerificationResult> {
    const response = await this.fetch(
      `${this.baseUrl}${VENDOR_SESSIONS_PATH}/${encodeURIComponent(sessionId)}`,
      { method: 'GET', headers: this.headers(), signal: this.signal() },
    )
    const text = await response.text()
    if (response.status === 404) {
      throw new EarthError('invalid_input', {
        details: { field: 'sessionId', reason: 'unknown_session' },
        message: `vendor verification: unknown session ${sessionId}`,
      })
    }
    if (!response.ok) {
      return technicalResult(sessionId, { httpStatus: response.status })
    }
    const payload = parseSessionPayload(text)
    if (payload === null) {
      return technicalResult(sessionId, { reason: 'malformed_response' })
    }
    return this.normalize(payload)
  }

  async verifyWebhook(
    rawBody: string,
    signatureHeader: string | null,
  ): Promise<VerificationWebhookEvent> {
    if (this.webhookSecret === undefined || this.webhookSecret.trim() === '') {
      throw new VerificationConfigError(
        HumanVerificationProviders.vendor,
        'HUMAN_VERIFICATION_WEBHOOK_SECRET is required to accept vendor callbacks.',
      )
    }
    if (this.subtle === undefined) {
      throw new VerificationConfigError(
        HumanVerificationProviders.vendor,
        'WebCrypto (crypto.subtle) is unavailable; cannot verify vendor callbacks.',
      )
    }
    const provided = extractSignatureHexes(signatureHeader)
    const expected = await hmacSha256Hex(this.subtle, this.webhookSecret, rawBody)
    // Every candidate is compared (a vendor rotating its secret may send two `v1=` entries);
    // each comparison is constant-time and none short-circuits the others.
    let matched = false
    for (const candidate of provided) {
      matched = constantTimeEqualHex(candidate, expected) ? true : matched
    }
    if (!matched) {
      throw new EarthError('forbidden', {
        details: { provider: this.kind, reason: 'invalid_signature' },
        message: 'vendor verification: webhook signature mismatch',
      })
    }
    const payload = parseWebhookPayload(rawBody)
    if (payload === null) {
      throw new EarthError('invalid_input', {
        details: { provider: this.kind, reason: 'malformed_webhook' },
        message: 'vendor verification: webhook body is not a session payload',
      })
    }
    return { sessionId: payload.id, result: this.normalize(payload) }
  }

  /**
   * Vendor session payload → normalized result. Only scalars leave; the payload stays in
   * metadata. A named `duplicate_of` or a duplicate status word makes the result a
   * `review_required` duplicate even if the vendor also says "approved" (spec §48, §128).
   */
  normalize(payload: VendorSessionPayload): VerificationResult {
    const vendorStatus = (payload.status ?? '').trim().toLowerCase()
    const mappedStatus = this.statusMap[vendorStatus] ?? VerificationStatuses.error
    const risk = (payload.risk_level ?? payload.risk ?? '').trim().toLowerCase()
    const duplicateRaw = (payload.duplicate_of_subject ?? payload.duplicate_of ?? '').trim()
    // Any named match is duplicate evidence; only one of our ids is passed on as the Human.
    const namesDuplicate = duplicateRaw !== ''
    const duplicateOfHumanId: HumanId | null =
      namesDuplicate && isUuid(duplicateRaw) ? (duplicateRaw as HumanId) : null
    const vendor: Record<string, unknown> = { ...payload }
    const base = {
      status: mappedStatus,
      riskLevel: isRiskLevel(risk) ? risk : null,
      providerReference: payload.id,
      duplicateOfHumanId,
      metadata: {
        provider: this.kind,
        vendorStatus: payload.status ?? null,
        mapped: vendorStatus in this.statusMap,
        vendor,
      },
    }
    const failureKind: VerificationFailureKind | null =
      namesDuplicate || this.duplicateStatuses.has(vendorStatus)
        ? VerificationFailureKinds.duplicate
        : failureKindForResult(base)
    if (failureKind === VerificationFailureKinds.duplicate) {
      return { ...base, status: VerificationStatuses.review_required, failureKind }
    }
    return failureKind === null ? base : { ...base, failureKind }
  }

  private headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, accept: 'application/json', ...extra }
  }

  private signal(): AbortSignal | undefined {
    const timeout: ((ms: number) => AbortSignal) | undefined =
      typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout.bind(AbortSignal)
        : undefined
    return timeout === undefined ? undefined : timeout(this.timeoutMs)
  }

  private expiresAt(raw: string | undefined): string {
    const parsed = raw === undefined ? Number.NaN : Date.parse(raw)
    const fallback = this.now().getTime() + DEFAULT_VENDOR_SESSION_TTL_MS
    return new Date(Number.isNaN(parsed) ? fallback : parsed).toISOString()
  }
}

/** Used when the vendor omits `expires_at`. */
export const DEFAULT_VENDOR_SESSION_TTL_MS = 30 * 60 * 1000

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function toSessionPayload(record: Record<string, unknown>): VendorSessionPayload | null {
  const id = optionalString(record, 'id') ?? optionalString(record, 'session_id')
  if (id === undefined || id === '') return null
  return {
    ...record,
    id,
    url: optionalString(record, 'url'),
    expires_at: optionalString(record, 'expires_at'),
    status: optionalString(record, 'status'),
    risk: optionalString(record, 'risk'),
    risk_level: optionalString(record, 'risk_level'),
    duplicate_of: optionalString(record, 'duplicate_of'),
    duplicate_of_subject: optionalString(record, 'duplicate_of_subject'),
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export function parseSessionPayload(text: string): VendorSessionPayload | null {
  const record = asRecord(parseJson(text))
  return record === null ? null : toSessionPayload(record)
}

/** Webhooks wrap the session as `{ session }`, `{ data }`, or send it flat. */
export function parseWebhookPayload(text: string): VendorSessionPayload | null {
  const record = asRecord(parseJson(text))
  if (record === null) return null
  const nested = asRecord(record['session']) ?? asRecord(record['data'])
  return toSessionPayload(nested ?? record)
}

function technicalResult(sessionId: string, detail: Record<string, unknown>): VerificationResult {
  return {
    status: VerificationStatuses.error,
    riskLevel: null,
    providerReference: sessionId,
    duplicateOfHumanId: null,
    metadata: { provider: HumanVerificationProviders.vendor, ...detail },
    failureKind: VerificationFailureKinds.technical,
  }
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

const HEX_REGEX = /^[0-9a-f]+$/
const HMAC_ALGORITHM = 'HMAC' as const
const HMAC_HASH = 'SHA-256' as const

/** Upper bound on signature candidates read from one header, so a huge header costs bounded work. */
export const MAX_SIGNATURE_CANDIDATES = 8

/**
 * Accepts a bare hex digest, `sha256=<hex>`, or a comma-separated `k=v` list with `v1` (or
 * `sha256`/`s`) entries — several during a secret rotation. Returns every usable candidate as
 * lowercase hex, in header order, at most {@link MAX_SIGNATURE_CANDIDATES}.
 */
export function extractSignatureHexes(header: string | null): readonly string[] {
  if (header === null) return []
  const trimmed = header.trim()
  if (trimmed === '') return []
  const candidates: string[] = []
  if (trimmed.includes('=')) {
    for (const part of trimmed.split(',')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      const key = part.slice(0, eq).trim().toLowerCase()
      const value = part.slice(eq + 1).trim()
      if (key === 'v1' || key === 'sha256' || key === 's') candidates.push(value)
    }
  } else {
    candidates.push(trimmed)
  }
  const usable: string[] = []
  for (const candidate of candidates) {
    if (usable.length >= MAX_SIGNATURE_CANDIDATES) break
    const hex = candidate.toLowerCase()
    if (HEX_REGEX.test(hex) && hex.length % 2 === 0) usable.push(hex)
  }
  return usable
}

/** The first usable candidate of {@link extractSignatureHexes}, or `null`. */
export function extractSignatureHex(header: string | null): string | null {
  return extractSignatureHexes(header)[0] ?? null
}

export async function hmacSha256Hex(
  subtle: SubtleCryptoLike,
  secret: string,
  data: string,
): Promise<string> {
  const encoder = new TextEncoder()
  const key = await subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: HMAC_ALGORITHM, hash: HMAC_HASH },
    false,
    ['sign'],
  )
  const signature = await subtle.sign(HMAC_ALGORITHM, key, encoder.encode(data))
  return bytesToHex(new Uint8Array(signature))
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * Compares two digests without any data-dependent early exit: the loop always runs over the
 * longer input and a length difference is folded into the same accumulator, so timing does not
 * leak how much of the expected digest an attacker has matched. (`charCodeAt` past the end is
 * `NaN`, which bitwise operators treat as 0.)
 */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
