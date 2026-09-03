'use client'

import { useCallback } from 'react'

import { localStore } from '../../../lib/storage'
import { browserFingerprintCrypto, fingerprintHash } from './fingerprint'

/** Resolves the device fingerprint hash on demand (never during render). */
export function useDeviceFingerprint(): () => Promise<string | null> {
  return useCallback(async () => {
    const crypto = browserFingerprintCrypto()
    if (crypto === null) return null
    return fingerprintHash(localStore(), crypto)
  }, [])
}
