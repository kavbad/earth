import { describe, expect, it } from 'vitest'

import { createMemoryStorage } from '../../../lib/storage'
import { DEVICE_ID_KEY, deviceId, fingerprintHash, toHex } from './fingerprint'

const crypto = { randomUUID: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }

describe('device fingerprint (spec §34)', () => {
  it('mints a device id once and keeps it', () => {
    const storage = createMemoryStorage()
    expect(deviceId(storage, crypto)).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(storage.values.get(DEVICE_ID_KEY)).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(deviceId(storage, { randomUUID: () => 'other' })).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(deviceId(null, crypto)).toBeNull()
  })

  it('hashes the id with SHA-256 and falls back to the id without SubtleCrypto', async () => {
    const storage = createMemoryStorage()
    const digest = async (_algorithm: string, data: BufferSource) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer)
      return Uint8Array.from([bytes.length, 255]).buffer as ArrayBuffer
    }
    expect(await fingerprintHash(storage, { ...crypto, digest })).toBe('24ff')
    expect(await fingerprintHash(storage, crypto)).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    expect(await fingerprintHash(null, crypto)).toBeNull()
  })

  it('renders bytes as lowercase hex', () => {
    expect(toHex(Uint8Array.from([0, 15, 255]).buffer as ArrayBuffer)).toBe('000fff')
  })
})
