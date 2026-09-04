import { describe, expect, it } from 'vitest'

import {
  createChunkedStorage,
  createMemoryChunkBackend,
  manifestFor,
  parseManifest,
  splitChunks,
} from './chunkedStorage'

describe('splitChunks', () => {
  it('slices into equal pieces with a shorter tail', () => {
    expect(splitChunks('abcdefg', 3)).toEqual(['abc', 'def', 'g'])
    expect(splitChunks('abc', 3)).toEqual(['abc'])
    expect(splitChunks('', 3)).toEqual([''])
  })
  it('refuses a non-positive size', () => {
    expect(() => splitChunks('a', 0)).toThrow()
  })
})

describe('parseManifest', () => {
  it('reads only well-formed manifests', () => {
    expect(parseManifest(manifestFor(4))).toBe(4)
    expect(parseManifest('chunks:x')).toBeNull()
    expect(parseManifest('chunks:-1')).toBeNull()
    expect(parseManifest('{"access_token":"…"}')).toBeNull()
    expect(parseManifest(null)).toBeNull()
  })
})

describe('createChunkedStorage', () => {
  it('round-trips a value larger than one chunk and keeps every slice small', async () => {
    const backend = createMemoryChunkBackend()
    const storage = createChunkedStorage({ backend, chunkSize: 4 })
    await storage.setItem('sb-token', 'abcdefghij')
    expect(backend.values.get('sb-token')).toBe(manifestFor(3))
    for (const [key, value] of backend.values) {
      if (key !== 'sb-token') expect(value.length).toBeLessThanOrEqual(4)
    }
    expect(await storage.getItem('sb-token')).toBe('abcdefghij')
  })

  it('shrinks cleanly when a later value needs fewer chunks', async () => {
    const backend = createMemoryChunkBackend()
    const storage = createChunkedStorage({ backend, chunkSize: 4 })
    await storage.setItem('k', 'abcdefghij')
    await storage.setItem('k', 'ab')
    expect(await storage.getItem('k')).toBe('ab')
    expect([...backend.values.keys()].sort()).toEqual(['k', 'k.0'])
  })

  it('removes the manifest and every slice', async () => {
    const backend = createMemoryChunkBackend()
    const storage = createChunkedStorage({ backend, chunkSize: 4 })
    await storage.setItem('k', 'abcdefghij')
    await storage.removeItem('k')
    expect(backend.values.size).toBe(0)
    expect(await storage.getItem('k')).toBeNull()
  })

  it('reads a plain value written by an earlier build as itself', async () => {
    const backend = createMemoryChunkBackend()
    await backend.set('legacy', '{"a":1}')
    const storage = createChunkedStorage({ backend })
    expect(await storage.getItem('legacy')).toBe('{"a":1}')
  })

  it('reads a torn write as nothing rather than a corrupt session', async () => {
    const backend = createMemoryChunkBackend()
    await backend.set('k', manifestFor(2))
    await backend.set('k.0', 'ab')
    const storage = createChunkedStorage({ backend })
    expect(await storage.getItem('k')).toBeNull()
  })
})
