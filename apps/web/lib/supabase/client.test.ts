import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type BrowserSupabaseClientFactory,
  createSupabaseBrowserClient,
  getSupabaseBrowserClient,
  resetSupabaseBrowserClient,
} from './client'

const ENV = { SUPABASE_URL: 'http://localhost:54321', SUPABASE_ANON_KEY: 'anon' }

function fakeFactory() {
  const calls: { url: string; key: string }[] = []
  const factory: BrowserSupabaseClientFactory = (url, key) => {
    calls.push({ url, key })
    // The test only inspects identity; a fresh object stands in for the SDK client.
    return { url, key } as unknown as SupabaseClient
  }
  return { factory, calls }
}

afterEach(() => resetSupabaseBrowserClient())

describe('createSupabaseBrowserClient', () => {
  it('hands the public URL and anon key to the factory', () => {
    const { factory, calls } = fakeFactory()
    createSupabaseBrowserClient({ env: ENV, factory })
    expect(calls).toEqual([{ url: ENV.SUPABASE_URL, key: ENV.SUPABASE_ANON_KEY }])
  })

  it('builds a real @supabase/ssr browser client from the given env', () => {
    const client = createSupabaseBrowserClient({ env: ENV })
    expect(typeof client.rpc).toBe('function')
    expect(typeof client.auth.getSession).toBe('function')
  })
})

describe('getSupabaseBrowserClient', () => {
  it('memoises one client from the public env until reset', () => {
    const saved = {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      map: process.env.NEXT_PUBLIC_MAP_STYLE_URL,
    }
    process.env.NEXT_PUBLIC_SUPABASE_URL = ENV.SUPABASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = ENV.SUPABASE_ANON_KEY
    process.env.NEXT_PUBLIC_MAP_STYLE_URL = 'https://demotiles.maplibre.org/style.json'
    try {
      const first = getSupabaseBrowserClient()
      expect(getSupabaseBrowserClient()).toBe(first)
      resetSupabaseBrowserClient()
      expect(getSupabaseBrowserClient()).not.toBe(first)
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = saved.url
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = saved.key
      process.env.NEXT_PUBLIC_MAP_STYLE_URL = saved.map
    }
  })
})
