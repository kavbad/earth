/**
 * Guest device fingerprint (spec §34 `device_fingerprint_hash`): the SHA-256 of a random id kept
 * on the device. It ties repeat Guest sessions together for the "You've joined 3 Earth rooms"
 * moment (SCREEN 19) without identifying the person or the hardware.
 */
import { type KeyValueStorage, readString, writeString } from '../../../lib/storage'

export const DEVICE_ID_KEY = 'earth.guest.device' as const

export interface FingerprintCrypto {
  randomUUID(): string
  digest?: ((algorithm: string, data: BufferSource) => Promise<ArrayBuffer>) | undefined
}

export function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Reads the device id or mints one; `null` when nothing can be stored (private mode). */
export function deviceId(storage: KeyValueStorage | null, crypto: FingerprintCrypto): string | null {
  if (storage === null) return null
  const existing = readString(storage, DEVICE_ID_KEY)
  if (existing !== null && existing.length > 0) return existing
  const minted = crypto.randomUUID()
  writeString(storage, DEVICE_ID_KEY, minted)
  return readString(storage, DEVICE_ID_KEY) === minted ? minted : null
}

/** SHA-256 hex of the device id; the raw id when SubtleCrypto is unavailable (insecure origin). */
export async function fingerprintHash(
  storage: KeyValueStorage | null,
  crypto: FingerprintCrypto,
): Promise<string | null> {
  const id = deviceId(storage, crypto)
  if (id === null) return null
  if (crypto.digest === undefined) return id
  try {
    return toHex(await crypto.digest('SHA-256', new TextEncoder().encode(id)))
  } catch {
    return id
  }
}

export function browserFingerprintCrypto(): FingerprintCrypto | null {
  if (typeof globalThis.crypto === 'undefined' || typeof globalThis.crypto.randomUUID !== 'function') {
    return null
  }
  const subtle = globalThis.crypto.subtle
  return {
    randomUUID: () => globalThis.crypto.randomUUID(),
    digest: subtle === undefined ? undefined : (algorithm, data) => subtle.digest(algorithm, data),
  }
}
