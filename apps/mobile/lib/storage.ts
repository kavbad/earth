/**
 * Guarded key-value storage for the shell (spec §107 keeps the app usable regardless of
 * persistence). Asynchronous because the device store is AsyncStorage; tests and runtimes
 * without a store use the in-memory implementation. Nothing here imports React Native — the
 * AsyncStorage adapter lives in `deviceStorage.ts`.
 */

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export async function readString(
  store: KeyValueStorage | null,
  key: string,
): Promise<string | null> {
  if (store === null) return null
  try {
    return await store.getItem(key)
  } catch {
    return null
  }
}

export async function writeString(
  store: KeyValueStorage | null,
  key: string,
  value: string,
): Promise<void> {
  if (store === null) return
  try {
    await store.setItem(key, value)
  } catch {
    // Quota or a broken store: the value simply is not remembered.
  }
}

export async function removeKey(store: KeyValueStorage | null, key: string): Promise<void> {
  if (store === null) return
  try {
    await store.removeItem(key)
  } catch {
    // Nothing to do.
  }
}

/** Parses stored JSON through `parse` (a zod `safeParse`-style guard); malformed data reads as `null`. */
export async function readJson<T>(
  store: KeyValueStorage | null,
  key: string,
  parse: (value: unknown) => T | null,
): Promise<T | null> {
  const raw = await readString(store, key)
  if (raw === null) return null
  try {
    return parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeJson(
  store: KeyValueStorage | null,
  key: string,
  value: unknown,
): Promise<void> {
  return writeString(store, key, JSON.stringify(value))
}

/** In-memory storage for tests and for runtimes without a device store. */
export function createMemoryStorage(
  initial: Readonly<Record<string, string>> = {},
): KeyValueStorage & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => Promise.resolve(values.get(key) ?? null),
    setItem: (key, value) => {
      values.set(key, value)
      return Promise.resolve()
    },
    removeItem: (key) => {
      values.delete(key)
      return Promise.resolve()
    },
  }
}
