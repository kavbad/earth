import { describe, expect, it } from 'vitest'

import {
  createMemoryStorage,
  readJson,
  readString,
  removeKey,
  writeJson,
  writeString,
} from './storage'

describe('storage helpers', () => {
  it('read nothing and write nowhere without a store', async () => {
    expect(await readString(null, 'k')).toBeNull()
    await expect(writeString(null, 'k', 'v')).resolves.toBeUndefined()
    await expect(removeKey(null, 'k')).resolves.toBeUndefined()
  })

  it('round-trip strings and JSON through a store', async () => {
    const store = createMemoryStorage()
    await writeString(store, 'a', '1')
    expect(await readString(store, 'a')).toBe('1')
    await writeJson(store, 'b', { x: 2 })
    expect(
      await readJson(store, 'b', (v) => (typeof v === 'object' && v !== null ? v : null)),
    ).toEqual({
      x: 2,
    })
    await removeKey(store, 'a')
    expect(await readString(store, 'a')).toBeNull()
  })

  it('treats malformed JSON and a rejected parse as nothing stored', async () => {
    const store = createMemoryStorage({ bad: '{not json', num: '5' })
    expect(await readJson(store, 'bad', (v) => v)).toBeNull()
    expect(await readJson(store, 'num', (v) => (typeof v === 'string' ? v : null))).toBeNull()
  })

  it('swallows a throwing store', async () => {
    const broken = {
      getItem: () => Promise.reject(new Error('no')),
      setItem: () => Promise.reject(new Error('no')),
      removeItem: () => Promise.reject(new Error('no')),
    }
    expect(await readString(broken, 'k')).toBeNull()
    await expect(writeString(broken, 'k', 'v')).resolves.toBeUndefined()
    await expect(removeKey(broken, 'k')).resolves.toBeUndefined()
  })
})
