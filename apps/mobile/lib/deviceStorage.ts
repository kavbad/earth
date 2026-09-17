/**
 * The device key-value store behind the shell's remembered radius, the anonymous analytics id
 * and a pending claim: AsyncStorage, guarded so a missing native module (a broken install) reads
 * as "nothing stored" (spec §107 keeps the app usable regardless).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'

import type { KeyValueStorage } from './storage'

let cached: KeyValueStorage | null | undefined

export function deviceStorage(): KeyValueStorage | null {
  if (cached !== undefined) return cached
  try {
    const store: KeyValueStorage = {
      getItem: (key) => AsyncStorage.getItem(key),
      setItem: (key, value) => AsyncStorage.setItem(key, value),
      removeItem: (key) => AsyncStorage.removeItem(key),
    }
    cached = store
  } catch {
    cached = null
  }
  return cached
}
