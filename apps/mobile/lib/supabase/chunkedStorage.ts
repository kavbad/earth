/**
 * Splits large values across several keys of a size-limited backing store. The iOS keychain
 * behind `expo-secure-store` warns above 2048 bytes per value and a Supabase session (two JWTs
 * plus the user) is regularly larger, so the session is stored as `key` → `chunks:<n>` and
 * `key.<i>` → the i-th slice. A value at `key` that is not a manifest is read as the value itself
 * (a plain write from an earlier build). Pure: the backing store is injected.
 */

export interface ChunkBackend {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

/** Async `getItem`/`setItem`/`removeItem` — what supabase-js' `auth.storage` accepts. */
export interface AsyncKeyValueStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export const MANIFEST_PREFIX = 'chunks:' as const
/** Under the 2048-byte keychain warning with room for multi-byte characters. */
export const DEFAULT_CHUNK_SIZE = 1_800

export function chunkKey(key: string, index: number): string {
  return `${key}.${index}`
}

export function splitChunks(value: string, size: number = DEFAULT_CHUNK_SIZE): string[] {
  if (size <= 0) throw new Error('chunk size must be positive')
  if (value.length === 0) return ['']
  const chunks: string[] = []
  for (let at = 0; at < value.length; at += size) chunks.push(value.slice(at, at + size))
  return chunks
}

/** `chunks:3` → 3; anything else is not a manifest. */
export function parseManifest(value: string | null): number | null {
  if (value === null || !value.startsWith(MANIFEST_PREFIX)) return null
  const count = Number(value.slice(MANIFEST_PREFIX.length))
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

export function manifestFor(count: number): string {
  return `${MANIFEST_PREFIX}${count}`
}

export interface CreateChunkedStorageOptions {
  readonly backend: ChunkBackend
  readonly chunkSize?: number
}

export function createChunkedStorage(options: CreateChunkedStorageOptions): AsyncKeyValueStorage {
  const { backend } = options
  const size = options.chunkSize ?? DEFAULT_CHUNK_SIZE

  const removeChunks = async (key: string, count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) await backend.remove(chunkKey(key, index))
  }

  return {
    async getItem(key) {
      const head = await backend.get(key)
      const count = parseManifest(head)
      if (count === null) return head
      const parts: string[] = []
      for (let index = 0; index < count; index += 1) {
        const part = await backend.get(chunkKey(key, index))
        // A missing slice means a torn write: read as nothing rather than a corrupt session.
        if (part === null) return null
        parts.push(part)
      }
      return parts.join('')
    },
    async setItem(key, value) {
      const previous = parseManifest(await backend.get(key)) ?? 0
      const chunks = splitChunks(value, size)
      for (const [index, chunk] of chunks.entries()) await backend.set(chunkKey(key, index), chunk)
      await backend.set(key, manifestFor(chunks.length))
      if (previous > chunks.length) {
        for (let index = chunks.length; index < previous; index += 1) {
          await backend.remove(chunkKey(key, index))
        }
      }
    },
    async removeItem(key) {
      const count = parseManifest(await backend.get(key)) ?? 0
      await removeChunks(key, count)
      await backend.remove(key)
    },
  }
}

/** In-memory backend for tests. */
export function createMemoryChunkBackend(): ChunkBackend & {
  readonly values: Map<string, string>
} {
  const values = new Map<string, string>()
  return {
    values,
    get: (key) => Promise.resolve(values.get(key) ?? null),
    set: (key, value) => {
      values.set(key, value)
      return Promise.resolve()
    },
    remove: (key) => {
      values.delete(key)
      return Promise.resolve()
    },
  }
}
