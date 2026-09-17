/**
 * Client-generated message ids (spec §53 step 1): RFC 4122 v4 from `expo-crypto`, with the
 * `react-native-get-random-values` polyfilled `crypto.getRandomValues` as the fallback.
 */
import * as Crypto from 'expo-crypto'

export function randomClientId(): string {
  try {
    return Crypto.randomUUID()
  } catch {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
}
