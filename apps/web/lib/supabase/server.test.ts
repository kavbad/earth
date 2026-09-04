import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import {
  type CookieStoreLike,
  type ServerSupabaseClientFactory,
  cookieMethodsFor,
  createSupabaseServerClientFromCookies,
} from './server'

const ENV = { SUPABASE_URL: 'http://localhost:54321', SUPABASE_ANON_KEY: 'anon' }

function fakeStore(options: { throwOnSet?: boolean; withSet?: boolean } = {}) {
  const set: { name: string; value: string; options: unknown }[] = []
  const store: CookieStoreLike = {
    getAll: () => [
      { name: 'sb-access-token', value: 'a' },
      { name: 'theme', value: 'dark' },
    ],
    ...(options.withSet === false
      ? {}
      : {
          set: (name: string, value: string, cookieOptions: unknown) => {
            if (options.throwOnSet === true)
              throw new Error('Cookies can only be modified in a Server Action')
            set.push({ name, value, options: cookieOptions })
          },
        }),
  }
  return { store, set }
}

describe('cookieMethodsFor', () => {
  it('reads every cookie as name/value pairs', () => {
    const { store } = fakeStore()
    expect(cookieMethodsFor(store).getAll()).toEqual([
      { name: 'sb-access-token', value: 'a' },
      { name: 'theme', value: 'dark' },
    ])
  })

  it('writes cookies through the store and tolerates stores that cannot write', () => {
    const writable = fakeStore()
    cookieMethodsFor(writable.store).setAll([{ name: 'x', value: '1', options: { path: '/' } }])
    expect(writable.set).toEqual([{ name: 'x', value: '1', options: { path: '/' } }])

    const throwing = fakeStore({ throwOnSet: true })
    expect(() =>
      cookieMethodsFor(throwing.store).setAll([{ name: 'x', value: '1', options: {} }]),
    ).not.toThrow()

    const readOnly = fakeStore({ withSet: false })
    expect(() =>
      cookieMethodsFor(readOnly.store).setAll([{ name: 'x', value: '1', options: {} }]),
    ).not.toThrow()
  })
})

describe('createSupabaseServerClientFromCookies', () => {
  it('hands the env and cookie methods to the factory', () => {
    const calls: { url: string; key: string; cookies: unknown }[] = []
    const factory: ServerSupabaseClientFactory = (url, key, options) => {
      calls.push({ url, key, cookies: options.cookies.getAll() })
      return {} as SupabaseClient
    }
    createSupabaseServerClientFromCookies(fakeStore().store, { env: ENV, factory })
    expect(calls).toEqual([
      {
        url: ENV.SUPABASE_URL,
        key: ENV.SUPABASE_ANON_KEY,
        cookies: [
          { name: 'sb-access-token', value: 'a' },
          { name: 'theme', value: 'dark' },
        ],
      },
    ])
  })

  it('builds a real @supabase/ssr server client', () => {
    const client = createSupabaseServerClientFromCookies(fakeStore().store, { env: ENV })
    expect(typeof client.rpc).toBe('function')
  })
})
