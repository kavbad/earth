import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { EARTH_ERROR_CODES } from './domain'
import { createTestDb, type RoleClient, type RoleSpec, type TestDb } from './harness'

const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const SHA256_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const BASE64URL_TOKEN = /^[A-Za-z0-9_-]{43}$/
const RATE_LIMITED = 'rate_limited'
const INVALID_INPUT = 'invalid_input'
/** Same rule as earth.rate_limit_reduced_budget: half, rounded up. */
const reducedBudget = (max: number): number => Math.ceil(max / 2)

async function scalar<T>(db: TestDb, text: string, values: unknown[] = []): Promise<T> {
  const { rows } = await db.sql.query<{ v: T }>(`select (${text}) as v`, values)
  return rows[0]?.v as T
}

/**
 * The socket peer as Postgres sees this connection: loopback when the server is on the same host,
 * the bridge gateway (e.g. 172.18.0.1) when it is a container on a Docker network, and null over a
 * unix socket. `earth.client_address()` falls back to it when no proxy header is usable, so the
 * tests below compare against the peer they actually have rather than assuming loopback.
 */
async function socketPeer(db: TestDb): Promise<string> {
  const peer = await scalar<string | null>(db, 'host(inet_client_addr())')
  if (peer === null) throw new Error('these tests must connect to Postgres over TCP, not a socket')
  return peer
}

async function setHeaders(client: RoleClient, headers: Record<string, string>): Promise<void> {
  await client.query("select set_config('request.headers', $1, true)", [JSON.stringify(headers)])
}

describe('earth helpers (0004)', () => {
  let db: TestDb
  let alice: string
  let peer: string

  beforeAll(async () => {
    db = await createTestDb()
    alice = await db.createAuthUser()
    peer = await socketPeer(db)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('sha256_hex matches known vectors', async () => {
    expect(await scalar(db, "earth.sha256_hex('abc')")).toBe(SHA256_ABC)
    expect(await scalar(db, "earth.sha256_hex('')")).toBe(SHA256_EMPTY)
    expect(await scalar(db, 'earth.sha256_hex(null)')).toBeNull()
  })

  it('random_token is 43 chars of base64url and unique', async () => {
    const { rows } = await db.sql.query<{ token: string }>(
      'select earth.random_token() as token from generate_series(1, 20)',
    )
    const tokens = rows.map((row) => row.token)
    for (const token of tokens) expect(token).toMatch(BASE64URL_TOKEN)
    expect(new Set(tokens).size).toBe(tokens.length)
    expect(await scalar(db, 'length(earth.sha256_hex(earth.random_token()))')).toBe(64)
  })

  it('raise() throws the code as the message with errcode P0001', async () => {
    const error = await db.expectError(db.sql.query("select earth.raise('blocked')"), 'blocked')
    expect(error.code).toBe('P0001')
    expect(error.detail).toBeUndefined()

    const detailed = await db.expectError(
      db.sql.query("select earth.raise('not_a_member', 'group 42')"),
      'not_a_member',
    )
    expect(detailed.detail).toBe('group 42')

    const missing = await db.expectError(db.sql.query('select earth.raise(null)'), 'internal')
    expect(missing.code).toBe('P0001')
  })

  it('every domain error code round-trips through raise()', async () => {
    for (const code of EARTH_ERROR_CODES) {
      await db.expectError(db.sql.query('select earth.raise($1)', [code]), code)
    }
  })

  it('utc_now() follows the clock unless earth.now overrides it', async () => {
    const before = Date.now() - 5_000
    const real = await scalar<Date>(db, 'earth.utc_now()')
    expect(real.getTime()).toBeGreaterThan(before)

    const frozen = await db.asRole('service', async (client) => {
      await client.query("select set_config('earth.now', '2030-01-02T03:04:05Z', true)")
      const { rows } = await client.query<{ v: Date }>('select earth.utc_now() as v')
      return rows[0]?.v
    })
    expect(frozen?.toISOString()).toBe('2030-01-02T03:04:05.000Z')

    const after = await scalar<Date>(db, 'earth.utc_now()')
    expect(after.getFullYear()).toBeLessThan(2030)
  })

  it('jwt_claims() parses the request claims defensively', async () => {
    expect(await scalar(db, 'earth.jwt_claims()')).toEqual({})

    // authenticated cannot name earth.* directly; read the claims through a security definer probe.
    await db.sql.query(`
      create function public.probe_claims() returns jsonb
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.jwt_claims() $$;
      grant execute on function public.probe_claims() to anon, authenticated;
    `)
    expect(await db.rpc('probe_claims', {}, { userId: alice })).toMatchObject({
      sub: alice,
      role: 'authenticated',
    })
    expect(await db.rpc('probe_claims', {}, 'visitor')).toEqual({ role: 'anon' })

    const malformed = await db.asRole('service', async (client) => {
      await client.query("select set_config('request.jwt.claims', 'not json', true)")
      return client.query<{ v: unknown }>('select earth.jwt_claims() as v')
    })
    expect(malformed.rows[0]?.v).toEqual({})

    const notObject = await db.asRole('service', async (client) => {
      await client.query("select set_config('request.jwt.claims', '[1,2]', true)")
      return client.query<{ v: unknown }>('select earth.jwt_claims() as v')
    })
    expect(notObject.rows[0]?.v).toEqual({})
  })

  it('request_headers() parses request.headers defensively', async () => {
    expect(await scalar(db, 'earth.request_headers()')).toEqual({})
    const parse = (raw: string) =>
      db.asRole('service', async (client) => {
        await client.query("select set_config('request.headers', $1, true)", [raw])
        const { rows } = await client.query<{ v: unknown }>('select earth.request_headers() as v')
        return rows[0]?.v
      })
    expect(await parse('{"x-real-ip": "203.0.113.9", "accept": "*/*"}')).toEqual({
      'x-real-ip': '203.0.113.9',
      accept: '*/*',
    })
    expect(await parse('not json')).toEqual({})
    expect(await parse('["a"]')).toEqual({})
    expect(await parse('')).toEqual({})
  })

  it('client_address() prefers trusted proxy headers, uses the last x-forwarded-for hop, skips garbage', async () => {
    const address = (headers: Record<string, string> | null) =>
      db.asRole('service', async (client) => {
        if (headers !== null) await setHeaders(client, headers)
        const { rows } = await client.query<{ v: string | null }>(
          'select earth.client_address() as v',
        )
        return rows[0]?.v
      })
    // No headers: the socket peer.
    expect(await address(null)).toBe(peer)
    expect(
      await address({
        'cf-connecting-ip': '203.0.113.9',
        'x-real-ip': '198.51.100.7',
        'x-forwarded-for': '10.0.0.1, 192.0.2.1',
      }),
    ).toBe('203.0.113.9')
    expect(
      await address({ 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '10.0.0.1, 192.0.2.1' }),
    ).toBe('198.51.100.7')
    // The first hop is whatever the client sent; only the last hop was appended by a proxy.
    expect(await address({ 'x-forwarded-for': '10.0.0.1, 192.0.2.1' })).toBe('192.0.2.1')
    expect(await address({ 'x-forwarded-for': ' 2001:db8::1 ' })).toBe('2001:db8::1')
    expect(
      await address({ 'cf-connecting-ip': 'not-an-address', 'x-real-ip': '198.51.100.7/32' }),
    ).toBe('198.51.100.7')
    expect(await address({ 'cf-connecting-ip': '', 'x-forwarded-for': 'garbage' })).toBe(peer)
  })

  it('is_anonymous_jwt() and is_service_role() classify the caller', async () => {
    const classify = (as: RoleSpec) =>
      db.asRole(as, async (client) => {
        const { rows } = await client.query<{ anonymous: boolean; service: boolean }>(
          'select earth.is_anonymous_jwt() as anonymous, earth.is_service_role() as service',
        )
        return rows[0]
      })

    // earth.* is reached through security definer functions; run the probe as the owner.
    await db.sql.query(`
      create function public.probe_classify() returns jsonb
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select jsonb_build_object('anonymous', earth.is_anonymous_jwt(), 'service', earth.is_service_role()) $$;
      grant execute on function public.probe_classify() to anon, authenticated;
    `)
    expect(await db.rpc('probe_classify', {}, 'visitor')).toEqual({
      anonymous: false,
      service: false,
    })
    expect(await db.rpc('probe_classify', {}, { userId: alice })).toEqual({
      anonymous: false,
      service: false,
    })
    expect(await db.rpc('probe_classify', {}, { userId: alice, isAnonymous: true })).toEqual({
      anonymous: true,
      service: false,
    })
    expect(await db.rpc('probe_classify', {}, 'service')).toEqual({
      anonymous: false,
      service: true,
    })
    expect(await classify('service')).toEqual({ anonymous: false, service: true })

    // No JWT at all: the superuser session counts as the service (migrations, seeds, psql).
    expect(await scalar(db, 'earth.is_service_role()')).toBe(true)
    expect(await scalar(db, 'earth.is_anonymous_jwt()')).toBe(false)
  })
})

describe('rate limits (0005)', () => {
  let db: TestDb
  let alice: string
  let bob: string
  let peer: string

  beforeAll(async () => {
    db = await createTestDb()
    alice = await db.createAuthUser()
    bob = await db.createAuthUser()
    peer = await socketPeer(db)
    await db.sql.query(`
      create function public.probe_rate_limit(max_count integer, window_seconds integer) returns integer
      language sql security definer set search_path = public, earth, private, pg_temp
      as $$ select earth.rate_limit_for_caller('probe', max_count, window_seconds) $$;
      grant execute on function public.probe_rate_limit(integer, integer) to anon, authenticated;
    `)
  })

  afterAll(async () => {
    await db.drop()
  })

  const limit = (action: string, subject: string, max: number, window: number) =>
    db.sql.query<{ remaining: number }>('select earth.rate_limit($1, $2, $3, $4) as remaining', [
      action,
      subject,
      max,
      window,
    ])

  /** probe_rate_limit as `as`, optionally with request headers (what PostgREST would set). */
  const probe = (as: RoleSpec, max: number, headers?: Record<string, string>) =>
    db.asRole(as, async (client) => {
      if (headers !== undefined) await setHeaders(client, headers)
      const { rows } = await client.query<{ remaining: number }>(
        'select public.probe_rate_limit($1, 600) as remaining',
        [max],
      )
      return rows[0]?.remaining
    })

  const probeKeys = async (): Promise<string[]> => {
    const { rows } = await db.sql.query<{ key: string }>(
      "select key from private.rate_limits where key like 'probe:%'",
    )
    return rows.map((row) => row.key).sort()
  }

  /** Runs `fn` with earth.now advanced by `seconds`, committing its effects. */
  const atOffset = async <T>(seconds: number, fn: () => Promise<T>): Promise<T> => {
    await db.sql.query('begin')
    try {
      await db.sql.query(
        "select set_config('earth.now', (now() + make_interval(secs => $1))::text, true)",
        [seconds],
      )
      const result = await fn()
      await db.sql.query('commit')
      return result
    } catch (error) {
      await db.sql.query('rollback')
      throw error
    }
  }

  it('allows max_count attempts in a window then raises rate_limited', async () => {
    expect((await limit('send', 'alice', 3, 60)).rows[0]?.remaining).toBe(2)
    expect((await limit('send', 'alice', 3, 60)).rows[0]?.remaining).toBe(1)
    expect((await limit('send', 'alice', 3, 60)).rows[0]?.remaining).toBe(0)
    const error = await db.expectError(limit('send', 'alice', 3, 60), RATE_LIMITED)
    expect(error.detail).toContain('send: attempt 4 of 3 within 60s')
    // A refused attempt rolls back its own increment: the counter stays at the limit, and the
    // window carries its own expiry.
    const { rows } = await db.sql.query<{ count: number; window_ok: boolean }>(
      `select count, expires_at = window_start + interval '60 seconds' as window_ok
         from private.rate_limits where key = 'send:alice'`,
    )
    expect(rows[0]).toEqual({ count: 3, window_ok: true })
    await db.expectError(limit('send', 'alice', 3, 60), RATE_LIMITED)
  })

  it('keys budgets by action and subject independently', async () => {
    expect((await limit('send', 'bob', 3, 60)).rows[0]?.remaining).toBe(2)
    expect((await limit('post', 'alice', 1, 60)).rows[0]?.remaining).toBe(0)
    await db.expectError(limit('post', 'alice', 1, 60), RATE_LIMITED)
  })

  it('starts a fresh window once window_seconds have passed', async () => {
    const remaining = await atOffset(61, async () => (await limit('send', 'alice', 3, 60)).rows[0])
    expect(remaining?.remaining).toBe(2)
    const { rows } = await db.sql.query<{ count: number; moved: boolean }>(
      `select count, window_start > now() as moved
         from private.rate_limits where key = 'send:alice'`,
    )
    expect(rows[0]).toEqual({ count: 1, moved: true })
  })

  it('rejects invalid arguments with invalid_input', async () => {
    await db.expectError(limit('', 'x', 1, 60), INVALID_INPUT)
    await db.expectError(limit('a', '', 1, 60), INVALID_INPUT)
    await db.expectError(limit('a', 'x', -1, 60), INVALID_INPUT)
    await db.expectError(limit('a', 'x', 1, 0), INVALID_INPUT)
    // ':' separates action from subject in the key, so an action must not contain it.
    await db.expectError(limit('a:b', 'x', 1, 60), INVALID_INPUT)
    await db.expectError(limit('a', 'x', 0, 60), RATE_LIMITED)
  })

  it('rate_limit_reduced_budget halves and rounds up, never to zero', async () => {
    for (const [max, expected] of [
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 3],
      [100, 50],
    ] as const) {
      expect(await scalar(db, 'earth.rate_limit_reduced_budget($1)', [max]), `${max}`).toBe(
        expected,
      )
      expect(reducedBudget(max)).toBe(expected)
    }
  })

  it('rate_limit_for_caller keys Humans by auth user id with the full budget', async () => {
    expect(await probe({ userId: alice }, 4)).toBe(3)
    expect(await probe({ userId: alice }, 4)).toBe(2)
    expect(await probe({ userId: alice }, 4)).toBe(1)
    expect(await probe({ userId: alice }, 4)).toBe(0)
    await db.expectError(probe({ userId: alice }, 4), RATE_LIMITED)
    // Another user has an independent budget.
    expect(await probe({ userId: bob }, 4)).toBe(3)
    expect(await probeKeys()).toEqual([`probe:${alice}`, `probe:${bob}`].sort())
  })

  it('anonymous JWTs (Guests) get the reduced budget, keyed by their auth user id', async () => {
    const guest = await db.createAuthUser({ isAnonymous: true })
    const asGuest = { userId: guest, isAnonymous: true }
    expect(await probe(asGuest, 4)).toBe(reducedBudget(4) - 1)
    expect(await probe(asGuest, 4)).toBe(0)
    await db.expectError(probe(asGuest, 4), RATE_LIMITED)

    const other = await db.createAuthUser({ isAnonymous: true })
    const asOther = { userId: other, isAnonymous: true }
    expect(await probe(asOther, 5)).toBe(2)
    expect(await probe(asOther, 5)).toBe(1)
    expect(await probe(asOther, 5)).toBe(0)
    await db.expectError(probe(asOther, 5), RATE_LIMITED)
    expect(await probeKeys()).toContain(`probe:${guest}`)
    expect(await probeKeys()).toContain(`probe:${other}`)
  })

  it('visitors get the reduced budget, keyed by the client address behind the API', async () => {
    // Behind a Cloudflare-fronted API every request reaches Postgres from PostgREST's own address;
    // the end client is identified by the trusted proxy headers, so two visitors are independent.
    const first = { 'cf-connecting-ip': '203.0.113.9' }
    const second = { 'cf-connecting-ip': '198.51.100.7' }
    expect(await probe('visitor', 4, first)).toBe(reducedBudget(4) - 1)
    expect(await probe('visitor', 4, first)).toBe(0)
    await db.expectError(probe('visitor', 4, first), RATE_LIMITED)
    expect(await probe('visitor', 4, second)).toBe(reducedBudget(4) - 1)

    // Without proxy headers the socket peer is the key.
    expect(await probe('visitor', 2)).toBe(0)
    await db.expectError(probe('visitor', 2), RATE_LIMITED)

    const keys = await probeKeys()
    expect(keys).toContain('probe:203.0.113.9')
    expect(keys).toContain('probe:198.51.100.7')
    expect(keys).toContain(`probe:${peer}`)
  })

  it('a visitor is never trusted more than a Guest, who is never trusted more than a Human', async () => {
    const human = await db.createAuthUser()
    const guest = await db.createAuthUser({ isAnonymous: true })
    const attempts = async (as: RoleSpec, headers?: Record<string, string>): Promise<number> => {
      let n = 0
      for (;;) {
        try {
          await probe(as, 5, headers)
          n += 1
        } catch {
          return n
        }
      }
    }
    const humanAttempts = await attempts({ userId: human })
    const guestAttempts = await attempts({ userId: guest, isAnonymous: true })
    const visitorAttempts = await attempts('visitor', { 'cf-connecting-ip': '192.0.2.44' })
    expect(humanAttempts).toBe(5)
    expect(guestAttempts).toBe(reducedBudget(5))
    expect(visitorAttempts).toBeLessThanOrEqual(guestAttempts)
    expect(visitorAttempts).toBeGreaterThan(0)
  })

  it('the service role is never limited', async () => {
    for (let i = 0; i < 3; i += 1) expect(await probe('service', 1)).toBe(1)
    const { rows } = await db.sql.query<{ remaining: number }>(
      "select earth.rate_limit_for_caller('probe', 1, 600) as remaining",
    )
    expect(rows[0]?.remaining).toBe(1)
  })

  it('rate_limit_prune removes only expired windows, whatever their length', async () => {
    const day = 86_400
    await limit('short', 'x', 5, 60)
    await limit('long', 'x', 5, 7 * day)
    const prune = async (args = ''): Promise<number> =>
      (await db.sql.query<{ deleted: number }>(`select earth.rate_limit_prune(${args}) as deleted`))
        .rows[0]?.deleted ?? -1

    const keys = async (): Promise<string[]> =>
      (
        await db.sql.query<{ key: string }>(
          "select key from private.rate_limits where key in ('short:x', 'long:x') order by key",
        )
      ).rows.map((row) => row.key)

    // Nothing has expired yet.
    expect(await prune()).toBe(0)
    expect(await keys()).toEqual(['long:x', 'short:x'])

    // Two days in: the minute window has expired (with every other short window this file made),
    // the week-long one is live and keeps counting.
    await atOffset(2 * day, async () => {
      expect(await prune()).toBeGreaterThanOrEqual(1)
      expect(await keys()).toEqual(['long:x'])
      expect((await limit('long', 'x', 5, 7 * day)).rows[0]?.remaining).toBe(3)
    })
    const { rows } = await db.sql.query<{ count: number }>(
      "select count from private.rate_limits where key = 'long:x'",
    )
    expect(rows[0]?.count).toBe(2)

    // Just past the week: a grace of one day keeps it, the default removes it.
    await atOffset(7 * day + 3_600, async () => {
      await prune(String(day))
      expect(await keys()).toEqual(['long:x'])
      expect(await prune()).toBeGreaterThanOrEqual(1)
      expect(await keys()).toEqual([])
    })

    await db.expectError(db.sql.query('select earth.rate_limit_prune(-1)'), INVALID_INPUT)
  })
})
