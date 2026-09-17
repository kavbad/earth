/**
 * The device key-value store behind own shares and device preferences: AsyncStorage, guarded so
 * a missing native module (a web preview, a broken install) reads as "nothing stored".
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
