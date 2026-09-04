import { EarthError, EARTH_ERROR_HTTP_STATUS } from '@earth/domain'
import { createLogger, createMemorySink } from '@earth/observability'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  clientFor,
  error,
  errorResponse,
  isErrorBody,
  mapError,
  ok,
  optionalBearer,
  parseInput,
  parseOutput,
  readBody,
  readJson,
  requestPath,
  requestQuery,
  requireBearer,
  rpc,
  rpcAdmin,
  rpcAs,
} from './http'
import {
  FakeRpcFailure,
  createFakeDeps,
  createFakeSupabase,
  fakeRequest,
  rpcFailure,
} from './test/fakes'

describe('responses', () => {
  it('ok() carries a JSON content type and the body', () => {
    const res = ok({ hello: 'world' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/json')
    expect(res.body).toEqual({ hello: 'world' })
  })

  it('error() produces { error: { code, message } } with optional details', () => {
    expect(error(403, 'forbidden').body).toEqual({
      error: { code: 'forbidden', message: 'forbidden' },
    })
    expect(error(400, 'invalid_input', { field: 'x' }).body).toEqual({
      error: { code: 'invalid_input', message: 'invalid_input', details: { field: 'x' } },
    })
    expect(isErrorBody(error(403, 'forbidden').body)).toBe(true)
    expect(isErrorBody({ ok: true })).toBe(false)
  })
})

describe('mapError', () => {
  const cases: [string, unknown, number, string][] = [
    ['not_authenticated', new EarthError('not_authenticated'), 401, 'not_authenticated'],
    ['forbidden', new EarthError('forbidden'), 403, 'forbidden'],
    ['not_a_human', new EarthError('not_a_human'), 403, 'not_a_human'],
    ['blocked', new EarthError('blocked'), 403, 'blocked'],
    ['guest_not_allowed', new EarthError('guest_not_allowed'), 403, 'guest_not_allowed'],
    ['room_not_found', new EarthError('room_not_found'), 404, 'room_not_found'],
    ['post_not_found', new EarthError('post_not_found'), 404, 'post_not_found'],
    ['not_visible', new EarthError('not_visible'), 404, 'not_visible'],
    ['rate_limited', new EarthError('rate_limited'), 429, 'rate_limited'],
    ['invalid_input', new EarthError('invalid_input'), 400, 'invalid_input'],
    ['audience_too_wide', new EarthError('audience_too_wide'), 400, 'audience_too_wide'],
    ['feature_disabled', new EarthError('feature_disabled'), 403, 'feature_disabled'],
    ['internal', new EarthError('internal'), 500, 'internal'],
    ['postgres error object', { message: 'not_a_member', code: 'P0001' }, 403, 'not_a_member'],
    ['bare code string', 'rate_limited', 429, 'rate_limited'],
    ['unknown Error', new Error('boom'), 500, 'internal'],
    ['zod error', new z.ZodError([]), 400, 'invalid_input'],
  ]
  it.each(cases)('%s → status/code', (_name, input, status, code) => {
    const res = mapError(input)
    expect(res.status).toBe(status)
    expect(res.body).toMatchObject({ error: { code } })
  })

  it('consent_required follows the domain table (409)', () => {
    expect(mapError(new EarthError('consent_required')).status).toBe(
      EARTH_ERROR_HTTP_STATUS.consent_required,
    )
    expect(EARTH_ERROR_HTTP_STATUS.consent_required).toBe(409)
  })

  it('never echoes details of a 500 and logs it at error level', () => {
    const sink = createMemorySink()
    const logger = createLogger({ sink: sink.sink, level: 'debug' })
    const res = mapError(new EarthError('internal', { details: { secret: 'x' } }), logger)
    expect(res.body).toEqual({ error: { code: 'internal', message: 'internal' } })
    expect(sink.records.some((r) => r.level === 'error' && r.msg === 'server.request_failed')).toBe(
      true,
    )
  })

  it('keeps 4xx details and logs them at debug level', () => {
    const sink = createMemorySink()
    const logger = createLogger({ sink: sink.sink, level: 'debug' })
    const res = mapError(new EarthError('invalid_input', { details: { field: 'cursor' } }), logger)
    expect(res.body).toMatchObject({
      error: { code: 'invalid_input', details: { field: 'cursor' } },
    })
    expect(sink.records[0]?.level).toBe('debug')
  })

  it('errorResponse maps every code to the domain status table', () => {
    for (const [code, status] of Object.entries(EARTH_ERROR_HTTP_STATUS)) {
      expect(
        errorResponse(new EarthError(code as keyof typeof EARTH_ERROR_HTTP_STATUS)).status,
      ).toBe(status)
    }
  })
})

describe('bearer extraction', () => {
  it('reads the bearer token', () => {
    const req = fakeRequest({ url: '/api/feed', bearer: 'abc.def' })
    expect(optionalBearer(req)).toBe('abc.def')
    expect(requireBearer(req)).toBe('abc.def')
  })

  it('is case-insensitive on the scheme and ignores other schemes', () => {
    expect(
      optionalBearer(fakeRequest({ url: '/x', headers: { authorization: 'bearer tok' } })),
    ).toBe('tok')
    expect(
      optionalBearer(fakeRequest({ url: '/x', headers: { authorization: 'Basic tok' } })),
    ).toBeNull()
    expect(
      optionalBearer(fakeRequest({ url: '/x', headers: { authorization: 'Bearer ' } })),
    ).toBeNull()
    expect(
      optionalBearer(fakeRequest({ url: '/x', headers: { authorization: 'Bearer' } })),
    ).toBeNull()
  })

  it('requireBearer throws not_authenticated without a token', () => {
    expect(() => requireBearer(fakeRequest({ url: '/x' }))).toThrow(EarthError)
    try {
      requireBearer(fakeRequest({ url: '/x' }))
    } catch (err) {
      expect((err as EarthError).code).toBe('not_authenticated')
    }
  })
})

describe('request helpers', () => {
  it('parses paths and queries from relative and absolute urls', () => {
    expect(requestPath(fakeRequest({ url: '/api/feed?scope=world' }))).toBe('/api/feed')
    expect(requestPath(fakeRequest({ url: 'https://earth.social/api/live?scope=city' }))).toBe(
      '/api/live',
    )
    expect(
      requestQuery(fakeRequest({ url: '/api/feed?scope=world&cursor=abc' })).get('cursor'),
    ).toBe('abc')
  })

  it('readJson maps malformed JSON to invalid_input and empty bodies to undefined', async () => {
    await expect(readJson(fakeRequest({ url: '/x', body: '{nope' }))).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(readJson(fakeRequest({ url: '/x' }))).resolves.toBeUndefined()
  })

  it('readBody validates with the schema (empty body → {})', async () => {
    const schema = z.object({ limit: z.number().default(5) })
    await expect(readBody(fakeRequest({ url: '/x' }), schema)).resolves.toEqual({ limit: 5 })
    await expect(
      readBody(fakeRequest({ url: '/x', body: { limit: 'x' } }), schema),
    ).rejects.toMatchObject({
      code: 'invalid_input',
      details: { field: 'body' },
    })
  })

  it('parseInput reports issues; parseOutput reports internal', () => {
    const schema = z.object({ a: z.string() })
    expect(() => parseInput(schema, { a: 1 })).toThrow(EarthError)
    try {
      parseOutput(schema, { a: 1 }, 'Thing')
    } catch (err) {
      expect((err as EarthError).code).toBe('internal')
      expect((err as EarthError).details).toMatchObject({ what: 'Thing' })
    }
  })
})

describe('rpc helpers', () => {
  const Dto = z.object({ value: z.number() })

  it('returns parsed data on success', async () => {
    const fake = createFakeSupabase({ thing_get: () => ({ value: 1, extra: true }) })
    await expect(rpcAs(fake.anon, 'thing_get', { id: 'x', skip: undefined }, Dto)).resolves.toEqual(
      { value: 1 },
    )
    expect(fake.calls[0]).toEqual({ client: 'anon', name: 'thing_get', args: { id: 'x' } })
  })

  it('converts Postgres error messages to EarthError codes', async () => {
    const fake = createFakeSupabase({
      thing_get: () => {
        throw rpcFailure('not_a_member')
      },
    })
    await expect(rpcAs(fake.anon, 'thing_get', {}, Dto)).rejects.toMatchObject({
      code: 'not_a_member',
    })
  })

  it('maps unknown database errors and thrown transport errors to internal', async () => {
    const fake = createFakeSupabase({
      broken: () => {
        throw rpcFailure('syntax error at or near')
      },
      network: () => {
        throw new Error('ECONNRESET')
      },
    })
    await expect(rpcAs(fake.anon, 'broken', {}, Dto)).rejects.toMatchObject({ code: 'internal' })
    await expect(rpcAs(fake.anon, 'network', {}, Dto)).rejects.toMatchObject({ code: 'internal' })
    await expect(rpcAs(fake.anon, 'missing', {}, Dto)).rejects.toMatchObject({ code: 'internal' })
  })

  it('treats a result that does not match the DTO as internal', async () => {
    const fake = createFakeSupabase({ thing_get: () => ({ value: 'nope' }) })
    await expect(rpcAs(fake.anon, 'thing_get', {}, Dto)).rejects.toMatchObject({ code: 'internal' })
  })

  it('rpc() picks the caller client: user token or anon', async () => {
    const { deps, supabase } = createFakeDeps({ rpc: { thing_get: () => ({ value: 2 }) } })
    await rpc(deps, 'tok', 'thing_get', {}, Dto)
    await rpc(deps, null, 'thing_get', {}, Dto)
    expect(supabase.calls.map((c) => c.client)).toEqual(['user:tok', 'anon'])
    expect(clientFor(deps, null)).toBe(deps.supabaseAnon)
  })
})

describe('adversarial: PostgREST auth failures and service RPC details', () => {
  const Dto = z.object({ value: z.number() })
  const jwtFailure = (code: string, message = 'JWT expired') =>
    createFakeSupabase({
      thing_get: () => {
        throw new FakeRpcFailure({ message, code, details: null, hint: null })
      },
    })

  it.each(['PGRST301', 'PGRST302', 'PGRST303'])(
    '%s from a caller client is not_authenticated (401), never a 500',
    async (code) => {
      const fake = jwtFailure(code)
      const { deps } = createFakeDeps()
      const withToken = { ...deps, supabaseForUser: () => fake.forUser('t') }
      await expect(rpc(withToken, 'expired', 'thing_get', {}, Dto)).rejects.toMatchObject({
        code: 'not_authenticated',
      })
    },
  )

  it('42501 (insufficient_privilege) from a caller client is forbidden', async () => {
    const fake = jwtFailure('42501', 'permission denied for function thing_get')
    const { deps } = createFakeDeps()
    const withToken = { ...deps, supabaseForUser: () => fake.forUser('t') }
    await expect(rpc(withToken, 't', 'thing_get', {}, Dto)).rejects.toMatchObject({
      code: 'forbidden',
    })
  })

  it('the same codes from the service-role client stay internal (a misconfiguration must be loud)', async () => {
    for (const code of ['PGRST301', 'PGRST303', '42501']) {
      const fake = jwtFailure(code)
      await expect(rpcAs(fake.admin, 'thing_get', {}, Dto)).rejects.toMatchObject({
        code: 'internal',
      })
    }
  })

  it('service RPC failures keep their code but never echo Postgres details/hints to the caller', async () => {
    const { deps } = createFakeDeps({
      rpc: {
        human_pass_record_result: () => {
          throw new FakeRpcFailure({
            message: 'duplicate_human',
            code: 'P0001',
            details: 'duplicate of 99999999-9999-4999-8999-999999999999',
            hint: 'private hint',
          })
        },
      },
    })
    const err = await rpcAdmin(deps, 'human_pass_record_result', {}, Dto).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'duplicate_human' })
    const response = mapError(err)
    expect(response.status).toBe(409)
    expect(JSON.stringify(response.body)).not.toContain('9999')
    expect(JSON.stringify(response.body)).not.toContain('hint')
  })

  it('caller RPC failures keep the details the database addressed to the caller', async () => {
    const { deps } = createFakeDeps({
      rpc: {
        thing_get: () => {
          throw rpcFailure('invalid_input', 'field: handle')
        },
      },
    })
    const err = await rpc(deps, 't', 'thing_get', {}, Dto).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'invalid_input', details: { detail: 'field: handle' } })
  })
})
