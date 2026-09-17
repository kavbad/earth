/**
 * `claim_started` fires once per claim attempt (spec §97): the claim sheet, the gate and the
 * invite entry all lead here, so the first of them marks the attempt and the others skip. The
 * mark lives for the app process — the mobile counterpart of the web's session storage.
 */
let tracked = false

export function isClaimTracked(): boolean {
  return tracked
}

export function markClaimTracked(): void {
  tracked = true
}

export function clearClaimTracked(): void {
  tracked = false
}
