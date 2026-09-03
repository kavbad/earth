/**
 * Cron protection for `/api/internal/*` (ARCHITECTURE §6, ADR-001): the platform scheduler sends
 * `INTERNAL_CRON_SECRET` in `x-earth-cron-secret`; the comparison is constant time so a wrong
 * guess learns nothing from timing.
 */
import { EarthError } from '@earth/domain'

import type { ServerDeps } from './deps'
import type { EarthRequest } from './http'

export const CRON_SECRET_HEADER = 'x-earth-cron-secret' as const

const encoder = new TextEncoder()

/** Compares two strings without early exit; the byte length is not hidden (secrets are fixed length). */
export function constantTimeEqual(a: string, b: string): boolean {
  const bytesA = encoder.encode(a)
  const bytesB = encoder.encode(b)
  const length = Math.max(bytesA.length, bytesB.length)
  let diff = bytesA.length ^ bytesB.length
  for (let i = 0; i < length; i += 1) {
    diff |= (bytesA[i] ?? 0) ^ (bytesB[i] ?? 0)
  }
  return diff === 0
}

/**
 * Throws `not_authenticated` (401) when the header is missing and `forbidden` (403) when it does
 * not match `deps.cronSecret`. An empty configured secret never matches.
 */
export function requireCronSecret(deps: ServerDeps, req: EarthRequest): void {
  const provided = req.headers.get(CRON_SECRET_HEADER)
  if (provided === null || provided.trim() === '') {
    throw new EarthError('not_authenticated', { details: { reason: 'missing_cron_secret' } })
  }
  if (deps.cronSecret === '' || !constantTimeEqual(provided.trim(), deps.cronSecret)) {
    throw new EarthError('forbidden', { details: { reason: 'invalid_cron_secret' } })
  }
}
