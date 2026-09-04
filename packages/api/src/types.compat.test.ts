/**
 * Compile-time guarantees: the real supabase-js client and the global `fetch` satisfy the
 * structural types every method is written against. `tsc` is the assertion; the runtime test only
 * keeps vitest from reporting an empty file.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import type { ServerFetch, SupabaseLike } from './types'

const asSupabaseLike = (client: SupabaseClient): SupabaseLike => client
const asServerFetch = (fetchImpl: typeof fetch): ServerFetch => fetchImpl

describe('structural compatibility', () => {
  it('SupabaseClient and fetch are assignable to the injected types', () => {
    expect(typeof asSupabaseLike).toBe('function')
    expect(typeof asServerFetch).toBe('function')
  })
})
