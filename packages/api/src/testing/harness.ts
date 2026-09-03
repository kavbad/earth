/**
 * An `EarthClient` wired to the fakes: every test (here and in apps) asserts on recorded RPC
 * calls, queries and requests instead of a database or a server.
 */
import { type EarthClient, createEarthClient } from '../client'
import {
  type FakeFetch,
  type FakeFetchHandler,
  type FakeResponseSpec,
  createFakeFetch,
} from './fake-fetch'
import { type FakeSupabase, type FakeSupabaseOptions, createFakeSupabase } from './fake-supabase'

export const TEST_SERVER_BASE_URL = 'https://api.earth.test' as const

export interface TestClientOptions extends FakeSupabaseOptions {
  readonly serverBaseUrl?: string | undefined
  readonly fetchHandler?: FakeFetchHandler | FakeResponseSpec | undefined
  readonly randomId?: (() => string) | undefined
  /** Overrides the session-derived bearer (`null` forces a Visitor even with a session). */
  readonly getAccessToken?: (() => Promise<string | null>) | undefined
}

export interface TestClientHarness {
  readonly client: EarthClient
  readonly supabase: FakeSupabase
  readonly fetch: FakeFetch
}

export function createTestClient(options: TestClientOptions = {}): TestClientHarness {
  const supabase = createFakeSupabase(options)
  const fetch = createFakeFetch(options.fetchHandler)
  const client = createEarthClient({
    supabase,
    serverBaseUrl: options.serverBaseUrl ?? TEST_SERVER_BASE_URL,
    fetch: fetch.fetch,
    getAccessToken: options.getAccessToken,
    randomId: options.randomId,
  })
  return { client, supabase, fetch }
}
