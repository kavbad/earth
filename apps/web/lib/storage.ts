/**
 * Guarded `localStorage` / `sessionStorage` access. Private mode, disabled storage and server
 * rendering all read as "nothing stored" and writes fail silently — persistence is a
 * convenience, never a requirement (spec §107 keeps the app usable regardless).
 */

export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function storage(kind: 'local' | 'session'): KeyValueStorage | null {
  if (typeof window === 'undefined') return null
  try {
    const store = kind === 'local' ? window.localStorage : window.sessionStorage
    // Some browsers expose the object but throw on first use.
    store.getItem('earth.probe')
    return store
  } catch {
    return null
  }
}

export function localStore(): KeyValueStorage | null {
  return storage('local')
}

export function sessionStore(): KeyValueStorage | null {
  return storage('session')
}

export function readString(store: KeyValueStorage | null, key: string): string | null {
  if (store === null) return null
  try {
    return store.getItem(key)
  } catch {
    return null
  }
}

export function writeString(store: KeyValueStorage | null, key: string, value: string): void {
  if (store === null) return
  try {
    store.setItem(key, value)
  } catch {
    // Quota, private mode: the value simply is not remembered.
  }
}

export function removeKey(store: KeyValueStorage | null, key: string): void {
  if (store === null) return
  try {
    store.removeItem(key)
  } catch {
    // Nothing to do.
  }
}

/** Parses stored JSON through `parse` (a zod `safeParse`-style guard); malformed data reads as `null`. */
export function readJson<T>(
  store: KeyValueStorage | null,
  key: string,
  parse: (value: unknown) => T | null,
): T | null {
  const raw = readString(store, key)
  if (raw === null) return null
  try {
    return parse(JSON.parse(raw))
  } catch {
    return null
  }
}

export function writeJson(store: KeyValueStorage | null, key: string, value: unknown): void {
  writeString(store, key, JSON.stringify(value))
}

/** In-memory storage for tests and for runtimes without web storage. */
export function createMemoryStorage(
  initial: Readonly<Record<string, string>> = {},
): KeyValueStorage & { readonly values: Map<string, string> } {
  const values = new Map(Object.entries(initial))
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    },
  }
}
