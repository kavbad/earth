/**
 * `claim_started` fires once per claim attempt (spec §97): the claim sheet, the gate and the
 * invite entry all lead here, so the first of them marks the session and the others skip.
 */
import { readString, removeKey, sessionStore, writeString } from '../storage'

export const CLAIM_TRACKED_KEY = 'earth.claim.tracked' as const

export function isClaimTracked(): boolean {
  return readString(sessionStore(), CLAIM_TRACKED_KEY) === '1'
}

export function markClaimTracked(): void {
  writeString(sessionStore(), CLAIM_TRACKED_KEY, '1')
}

export function clearClaimTracked(): void {
  removeKey(sessionStore(), CLAIM_TRACKED_KEY)
}
