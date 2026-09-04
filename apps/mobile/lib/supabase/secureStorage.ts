/**
 * The Supabase session lives in the device keychain / keystore (`expo-secure-store`), chunked
 * because the iOS keychain limits a value to 2048 bytes. `AFTER_FIRST_UNLOCK` lets the token
 * refresh while the app is backgrounded. A device without a secure store (rare; a broken
 * install) falls back to memory: the session simply is not remembered across launches.
 */
import * as SecureStore from 'expo-secure-store'

import {
  type AsyncKeyValueStorage,
  type ChunkBackend,
  createChunkedStorage,
  createMemoryChunkBackend,
} from './chunkedStorage'

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
}

/** SecureStore keys may only contain letters, digits, `.`, `-` and `_`. */
export function secureStoreKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function createSecureStoreBackend(): ChunkBackend {
  return {
    get: (key) => SecureStore.getItemAsync(secureStoreKey(key), SECURE_STORE_OPTIONS),
    set: (key, value) => SecureStore.setItemAsync(secureStoreKey(key), value, SECURE_STORE_OPTIONS),
    remove: (key) => SecureStore.deleteItemAsync(secureStoreKey(key), SECURE_STORE_OPTIONS),
  }
}

let cached: AsyncKeyValueStorage | undefined

/** The auth storage handed to supabase-js (`auth.storage`). */
export function createSecureSessionStorage(): AsyncKeyValueStorage {
  if (cached !== undefined) return cached
  let backend: ChunkBackend
  try {
    backend = createSecureStoreBackend()
  } catch {
    backend = createMemoryChunkBackend()
  }
  cached = createChunkedStorage({ backend })
  return cached
}
