import { EarthError } from '@earth/domain'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createFakeFetch } from './testing/fake-fetch'
import { createFakeSupabase, postgrestRaise } from './testing/fake-supabase'
import {
  HTTP_STATUS_TO_EARTH,
  POSTGREST_CODE_TO_EARTH,
  type Transport,
  cleanArgs,
  createTransport,
  defaultRandomId,
  httpErrorToEarthError,
  parseInput,
  parseOutput,
  postgrestErrorToEarthError,
  serverUrl,
} from './transport'

const Schema = z.object({ id: z.uuid(), count: z.int().default(0) })
const ID = '11111111-1111-4111-8111-111111111111'
const BASE = 'https://api.earth.test'

async function rejection(promise: Promise<unknown>): Promise<EarthError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof EarthError) return error
    throw error
  }
  throw new Error('expected rejection')
}

describe('parseInput / parseOutput', () => {
  it('returns parsed data with defaults applied', () => {
    expect(parseInput(Schema, { id: ID })).toEqual({ id: ID, count: 0 })
  })

  it('turns an invalid input into EarthError(invalid_input) with the issues', () => {
    let error: unknown
    try {
      parseInput(Schema, { id: 'nope' }, 'body')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(EarthError)
    const earth = error as EarthError
    expect(earth.code).toBe('invalid_input')
    expect(earth.details).toMatchObject({ field: 'body' })
    expect((earth.details?.['issues'] as { path: string }[])[0]?.path).toBe('id')
  })

  it('turns a contract mismatch into EarthError(internal) naming what failed', () => {
    let error: unknown
    try {
      parseOutput(Schema, { id: 1 }, 'rpc me_get')
    } catch (caught) {
      error = caught
    }
    const earth = error as EarthError
    expect(earth.code).toBe('internal')
    expect(earth.details).toMatchObject({ what: 'rpc me_get' })
  })
})

describe('postgrestErrorToEarthError', () => {
  it('maps a raised Earth code (message) to its EarthError', () => {
    const error = postgrestErrorToEarthError(postgrestRaise('not_a_member'), 'rpc group_get')
    expect(error.code).toBe('not_a_member')
  })

  it('maps RLS denials and JWT problems by PostgREST code', () => {
    expect(POSTGREST_CODE_TO_EARTH['42501']).toBe('forbidden')
    const denied = postgrestErrorToEarthError(
      { message: 'permission denied for table posts', code: '42501' },
      'rpc post_get',
    )
    expect(denied.code).toBe('forbidden')
    expect(denied.details).toMatchObject({ what: 'rpc post_get', postgrestCode: '42501' })
    const expired = postgrestErrorToEarthError({ message: 'JWT expired', code: 'PGRST301' }, 'x')
    expect(expired.code).toBe('not_authenticated')
  })

  it('keeps unknown errors as internal with the original as cause', () => {
    const original = { message: 'connection refused', code: 'PGRST000' }
    const error = postgrestErrorToEarthError(original, 'rpc me_get')
    expect(error.code).toBe('internal')
    expect(error.cause).toBe(original)
    expect(error.message).toContain('connection refused')
  })
})

describe('cleanArgs / serverUrl', () => {
  it('drops undefined but keeps null (PostgREST needs explicit nulls)', () => {
    expect(cleanArgs({ a: undefined, b: null, c: 0 })).toEqual({ b: null, c: 0 })
  })

  it('joins base, path and query, tolerating a trailing slash and skipping empty values', () => {
    expect(
      serverUrl(`${BASE}/`, '/api/feed', { scope: 'world', cursor: null, area: undefined, x: '' }),
    ).toBe(`${BASE}/api/feed?scope=world`)
    expect(serverUrl(BASE, '/api/live')).toBe(`${BASE}/api/live`)
    expect(serverUrl(BASE, '/api/feed', { cursor: 'a b+c' })).toBe(
      `${BASE}/api/feed?cursor=a+b%2Bc`,
    )
  })
})

describe('httpErrorToEarthError', () => {
  it('prefers the { error: { code } } body of the server tier', () => {
    const error = httpErrorToEarthError(
      429,
      { error: { code: 'rate_limited', details: { retryAfter: 3 } } },
      'GET /api/feed',
    )
    expect(error.code).toBe('rate_limited')
    expect(error.details).toEqual({ retryAfter: 3 })
  })

  it('falls back to the status mapping and keeps status + route in details', () => {
    expect(HTTP_STATUS_TO_EARTH[401]).toBe('not_authenticated')
    expect(httpErrorToEarthError(401, undefined, 'POST /api/x').code).toBe('not_authenticated')
    expect(httpErrorToEarthError(403, { message: 'nope' }, 'POST /api/x').code).toBe('forbidden')
    // A body whose code is not an Earth code (a proxy, an older server) also falls back.
    expect(httpErrorToEarthError(429, { error: { code: 'slow_down' } }, 'POST /api/x').code).toBe(
      'rate_limited',
    )
    expect(httpErrorToEarthError(400, 'Bad Request', 'POST /api/x').code).toBe('invalid_input')
    const unknown = httpErrorToEarthError(502, '<html>bad gateway</html>', 'GET /api/feed')
    expect(unknown.code).toBe('internal')
    expect(unknown.details).toEqual({ route: 'GET /api/feed', status: 502 })
  })
})

function transportWith(
  options: { accessToken?: string | null; getAccessToken?: () => Promise<string | null> } = {},
): {
  transport: Transport
  supabase: ReturnType<typeof createFakeSupabase>
  fetch: ReturnType<typeof createFakeFetch>
} {
  const supabase = createFakeSupabase({ accessToken: options.accessToken ?? null })
  const fetch = createFakeFetch({ status: 200, json: { id: ID } })
  const transport = createTransport({
    supabase,
    serverBaseUrl: BASE,
    fetch: fetch.fetch,
    getAccessToken: options.getAccessToken,
    randomId: () => 'rid',
  })
  return { transport, supabase, fetch }
}

describe('createTransport.rpc', () => {
  it('calls the rpc with cleaned args and parses the result', async () => {
    const { transport, supabase } = transportWith()
    supabase.rpcData('me_get', { id: ID, extra: 'stripped' })
    const result = await transport.rpc('me_get', { a: 1, b: undefined, c: null }, Schema)
    expect(result).toEqual({ id: ID, count: 0 })
    expect(supabase.lastRpc()).toEqual({ name: 'me_get', args: { a: 1, c: null } })
  })

  it('converts a PostgREST error result', async () => {
    const { transport, supabase } = transportWith()
    supabase.rpcError('group_get', postgrestRaise('not_a_member'))
    const error = await rejection(transport.rpc('group_get', {}, Schema))
    expect(error.code).toBe('not_a_member')
  })

  it('converts a rejected rpc call (transport failure) to internal', async () => {
    const { transport, supabase } = transportWith()
    const cause = new TypeError('fetch failed')
    supabase.rpcThrows('me_get', cause)
    const error = await rejection(transport.rpc('me_get', {}, Schema))
    expect(error.code).toBe('internal')
    expect(error.cause).toBe(cause)
  })

  it('reports a DTO mismatch as internal', async () => {
    const { transport, supabase } = transportWith()
    supabase.rpcData('me_get', { id: 'not-a-uuid' })
    const error = await rejection(transport.rpc('me_get', {}, Schema))
    expect(error.code).toBe('internal')
    expect(error.details).toMatchObject({ what: 'rpc me_get' })
  })

  it('rpcVoid ignores the result but still surfaces errors', async () => {
    const { transport, supabase } = transportWith()
    supabase.rpcData('post_hide', 'whatever')
    await expect(transport.rpcVoid('post_hide', { post_id: ID })).resolves.toBeUndefined()
    supabase.rpcError('post_hide', postgrestRaise('post_not_found'))
    expect((await rejection(transport.rpcVoid('post_hide', { post_id: ID }))).code).toBe(
      'post_not_found',
    )
  })
})

describe('createTransport.query', () => {
  it('runs the select chain and parses rows', async () => {
    const { transport, supabase } = transportWith()
    supabase.onQuery('feature_flags', { data: [{ id: ID, count: 2 }] })
    const rows = await transport.query(
      'select feature_flags',
      (table) =>
        table
          .select('id, count')
          .filter('id', 'eq', ID)
          .order('count', { ascending: false })
          .limit(5),
      'feature_flags',
      z.array(Schema),
    )
    expect(rows).toEqual([{ id: ID, count: 2 }])
    expect(supabase.lastQuery()).toMatchObject({
      table: 'feature_flags',
      columns: 'id, count',
      filters: [{ column: 'id', operator: 'eq', value: ID }],
      order: { column: 'count', ascending: false },
      limit: 5,
    })
  })

  it('maps RLS denials to forbidden', async () => {
    const { transport, supabase } = transportWith()
    supabase.onQuery('media_objects', { error: { message: 'permission denied', code: '42501' } })
    const error = await rejection(
      transport.query(
        'insert media_objects',
        (table) => table.insert({ a: 1 }).select('id').single(),
        'media_objects',
        Schema,
      ),
    )
    expect(error.code).toBe('forbidden')
  })
})

describe('createTransport.server', () => {
  it('sends the bearer from getAccessToken and parses the JSON body', async () => {
    const { transport, fetch } = transportWith({ getAccessToken: async () => 'tok_1' })
    const result = await transport.server(
      { method: 'GET', path: '/api/feed', query: { scope: 'world' }, auth: 'optional' },
      Schema,
    )
    expect(result).toEqual({ id: ID, count: 0 })
    const request = fetch.lastRequest()
    expect(request.url).toBe(`${BASE}/api/feed?scope=world`)
    expect(request.method).toBe('GET')
    expect(request.headers).toEqual({ accept: 'application/json', authorization: 'Bearer tok_1' })
    expect(request.rawBody).toBeUndefined()
  })

  it('falls back to the supabase session for the bearer and sends JSON bodies', async () => {
    const { transport, fetch, supabase } = transportWith({ accessToken: 'sess_tok' })
    await transport.server(
      { method: 'POST', path: '/api/rooms/x/token', body: { a: 1 }, auth: 'required' },
      Schema,
    )
    expect(supabase.sessionCalls).toBe(1)
    const request = fetch.lastRequest()
    expect(request.headers['authorization']).toBe('Bearer sess_tok')
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.body).toEqual({ a: 1 })
  })

  it('sends no authorization header for Visitors', async () => {
    const { transport, fetch } = transportWith()
    await transport.server({ method: 'GET', path: '/api/feed', auth: 'optional' }, Schema)
    expect(fetch.lastRequest().headers['authorization']).toBeUndefined()
  })

  it('refuses auth-required routes without a session before calling fetch', async () => {
    const { transport, fetch } = transportWith()
    const error = await rejection(
      transport.server({ method: 'POST', path: '/api/rooms/x/token', auth: 'required' }, Schema),
    )
    expect(error.code).toBe('not_authenticated')
    expect(error.details).toMatchObject({ reason: 'missing_session' })
    expect(fetch.requests).toHaveLength(0)
  })

  it('treats a throwing token getter as a Visitor', async () => {
    const { transport, fetch } = transportWith({
      getAccessToken: async () => Promise.reject(new Error('boom')),
    })
    await transport.server({ method: 'GET', path: '/api/feed', auth: 'optional' }, Schema)
    expect(fetch.lastRequest().headers['authorization']).toBeUndefined()
  })

  it('maps network failures to internal(network_error)', async () => {
    const { transport, fetch } = transportWith()
    fetch.fail(new TypeError('Failed to fetch'))
    const error = await rejection(
      transport.server({ method: 'GET', path: '/api/feed', auth: 'optional' }, Schema),
    )
    expect(error.code).toBe('internal')
    expect(error.details).toMatchObject({ reason: 'network_error', route: 'GET /api/feed' })
  })

  it('maps error responses through the JSON body, then the status', async () => {
    const { transport, fetch } = transportWith()
    fetch.respond({
      status: 409,
      json: { error: { code: 'consent_required', message: 'consent_required' } },
    })
    expect(
      (
        await rejection(
          transport.server({ method: 'GET', path: '/api/x', auth: 'optional' }, Schema),
        )
      ).code,
    ).toBe('consent_required')
    fetch.respond({ status: 401, text: 'Unauthorized' })
    expect(
      (
        await rejection(
          transport.server({ method: 'GET', path: '/api/x', auth: 'optional' }, Schema),
        )
      ).code,
    ).toBe('not_authenticated')
    fetch.respond({ status: 500, text: 'oops' })
    const internal = await rejection(
      transport.server({ method: 'GET', path: '/api/x', auth: 'optional' }, Schema),
    )
    expect(internal.code).toBe('internal')
    expect(internal.details).toMatchObject({ status: 500 })
  })

  it('reports malformed JSON on a 2xx as internal', async () => {
    const { transport, fetch } = transportWith()
    fetch.respond({ status: 200, text: '{not json' })
    const error = await rejection(
      transport.server({ method: 'GET', path: '/api/x', auth: 'optional' }, Schema),
    )
    expect(error.code).toBe('internal')
    expect(error.details).toMatchObject({ reason: 'malformed_json' })
  })

  it('serverVoid accepts empty bodies', async () => {
    const { transport, fetch } = transportWith()
    fetch.respond({ status: 202 })
    await expect(
      transport.serverVoid({
        method: 'POST',
        path: '/api/analytics/ingest',
        body: { v: 1 },
        auth: 'optional',
      }),
    ).resolves.toBeUndefined()
  })
})

describe('defaultRandomId', () => {
  it('produces uuid-shaped ids', () => {
    expect(defaultRandomId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(defaultRandomId()).not.toBe(defaultRandomId())
  })
})
