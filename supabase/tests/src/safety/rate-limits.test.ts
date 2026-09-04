/**
 * Rate limit review (spec §83; DB_API §7 "Rate limits"; 0730): every mutating RPC calls
 * earth.rate_limit_for_caller, the inventory documented in 0730 matches the calls found in the
 * function sources, Guests get the halved budget, and the service-only earth.rate_limit_reset helper.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { REPO_ROOT } from '../../../../scripts/db/migrate-lib'
import { createTestDb, type TestDb } from '../harness'
import {
  createGuest,
  errorCode,
  human,
  resetRateLimitsFor,
  rpcAt,
  secondsFromNow,
  type Human,
} from './fixtures'

/** RPC names that mutate by convention (ARCHITECTURE §5 `<noun>_<verb>`). */
const MUTATING_NAME =
  /^(.*_(create|send|set|join|start|toggle|register|share|request|remove|end|hide|update|revoke))$/

/**
 * Functions matching MUTATING_NAME that may skip earth.rate_limit_for_caller, with the reason. Empty
 * on purpose: every mutating RPC, service-only ones included, keeps the call (the service is never
 * limited, so the call costs nothing there and the rule stays visible in the source). Add an entry
 * only with a justification a reviewer can check; a stale entry (function gone) fails the test.
 */
const MUTATING_EXEMPT: Readonly<Record<string, string>> = {}

/**
 * Client-executable volatile functions that may skip earth.rate_limit_for_caller. Only functions
 * whose body refuses every caller but the service qualify (the service is never limited).
 */
const VOLATILE_EXEMPT: Readonly<Record<string, string>> = {
  human_pass_record_result:
    'service-only by role check (DB_API §1); granted to the API roles for PostgREST discovery only',
}

interface FunctionRow {
  name: string
  signature: string
  source: string
  volatile: boolean
  client_executable: boolean
}

async function publicFunctions(db: TestDb): Promise<FunctionRow[]> {
  const { rows } = await db.sql.query<FunctionRow>(
    `select p.proname as name,
            p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as signature,
            p.prosrc as source,
            p.provolatile = 'v' as volatile,
            (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')) as client_executable
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f'
      order by p.proname`,
  )
  return rows
}

/** Every `earth.rate_limit_for_caller('<action>', <max>, <window>)` literal call in public + earth sources. */
async function limitCalls(db: TestDb): Promise<Set<string>> {
  const { rows } = await db.sql.query<{ call: string }>(
    `select distinct m[1] || '|' || m[2] || '|' || m[3] as call
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace,
            regexp_matches(p.prosrc, 'rate_limit_for_caller\\(\\s*''([a-z_]+)''\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*\\)', 'g') m
      where n.nspname in ('public', 'earth')
      order by 1`,
  )
  return new Set(rows.map((r) => r.call))
}

/** Rows of the 0730 inventory: `-- | action | max | window_seconds | notes |`. */
async function documentedLimits(): Promise<Set<string>> {
  const text = await readFile(
    path.join(REPO_ROOT, 'supabase', 'migrations', '0730_rate_limit_audit.sql'),
    'utf8',
  )
  const rows = new Set<string>()
  for (const line of text.split('\n')) {
    const match = /^--\s*\|\s*([a-z_]+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|/.exec(line)
    if (match) rows.add(`${match[1]}|${match[2]}|${match[3]}`)
  }
  return rows
}

describe('rate limit review (0730)', () => {
  let db: TestDb
  let functions: FunctionRow[]

  beforeAll(async () => {
    db = await createTestDb()
    functions = await publicFunctions(db)
  })

  afterAll(async () => {
    await db.drop()
  })

  it('every public RPC whose name says it mutates calls earth.rate_limit_for_caller', () => {
    const mutating = functions.filter((f) => MUTATING_NAME.test(f.name))
    expect(mutating.length).toBeGreaterThan(30)
    const missing = mutating
      .filter((f) => !f.source.includes('rate_limit') && !(f.name in MUTATING_EXEMPT))
      .map((f) => f.signature)
    expect(
      missing,
      'mutating RPCs without a rate limit (add earth.rate_limit_for_caller or a justified exemption)',
    ).toEqual([])
    // Every rate-limited RPC goes through the caller-aware wrapper, never the raw earth.rate_limit.
    for (const f of mutating.filter((f) => f.source.includes('rate_limit'))) {
      expect(f.source, f.signature).toContain('earth.rate_limit_for_caller(')
    }
  })

  it('every client-executable volatile function calls earth.rate_limit_for_caller unless service-only', () => {
    const candidates = functions.filter((f) => f.volatile && f.client_executable)
    const missing = candidates
      .filter((f) => !f.source.includes('rate_limit') && !(f.name in VOLATILE_EXEMPT))
      .map((f) => f.signature)
    expect(missing, 'client-reachable volatile functions without a rate limit').toEqual([])
    for (const name of Object.keys(VOLATILE_EXEMPT)) {
      const fn = functions.find((f) => f.name === name)
      expect(fn, `stale exemption ${name}`).toBeDefined()
      expect(fn?.source, `${name} must refuse non-service callers`).toMatch(
        /current_role_kind\(\)\s*(<>|!=)\s*'service'|forbidden/,
      )
    }
  })

  it('exemption lists only name functions that exist', () => {
    const names = new Set(functions.map((f) => f.name))
    for (const name of Object.keys(MUTATING_EXEMPT))
      expect(names.has(name), `stale exemption ${name}`).toBe(true)
    for (const name of Object.keys(VOLATILE_EXEMPT))
      expect(names.has(name), `stale exemption ${name}`).toBe(true)
  })

  it('the inventory in 0730 lists exactly the limits found in the function sources', async () => {
    const actual = await limitCalls(db)
    const documented = await documentedLimits()
    expect(actual.size).toBeGreaterThan(50)
    expect(
      [...actual].filter((c) => !documented.has(c)),
      'limits missing from the 0730 inventory',
    ).toEqual([])
    expect(
      [...documented].filter((c) => !actual.has(c)),
      'inventory rows with no matching call',
    ).toEqual([])
  })

  it('no function calls earth.rate_limit_for_caller with a non-literal budget (the inventory would miss it)', () => {
    for (const f of functions) {
      const calls = f.source.match(/rate_limit_for_caller\([^)]*\)/g) ?? []
      for (const call of calls) {
        expect(call, f.signature).toMatch(
          /rate_limit_for_caller\(\s*'[a-z_]+'\s*,\s*\d+\s*,\s*\d+\s*\)/,
        )
      }
    }
  })

  it('report_create budgets: Humans 20/h, Guests 10 halved to 5/h', () => {
    const fn = functions.find((f) => f.name === 'report_create')
    expect(fn?.source).toContain("rate_limit_for_caller('report_create', 20, 3600)")
    expect(fn?.source).toContain("rate_limit_for_caller('report_create', 10, 3600)")
  })

  describe('earth.rate_limit_reset (service only)', () => {
    let alice: Human

    beforeAll(async () => {
      alice = await human(db, 'Alice')
      await db.sql.query(`
        create function public.probe_limited(max_count integer) returns integer
        language sql security definer set search_path = public, earth, private, pg_temp
        as $$ select earth.rate_limit_for_caller('probe', max_count, 3600) $$;
        grant execute on function public.probe_limited(integer) to anon, authenticated;
        create function public.probe_reset(subject text) returns integer
        language sql security definer set search_path = public, earth, private, pg_temp
        as $$ select earth.rate_limit_reset(subject) $$;
        grant execute on function public.probe_reset(text) to anon, authenticated;
      `)
    })

    it('is not executable by anon/authenticated; executable by the owner and the service', async () => {
      for (const role of ['anon', 'authenticated', 'public']) {
        const { rows } = await db.sql.query<{ ok: boolean }>(
          `select has_function_privilege($1, 'earth.rate_limit_reset(text, text)', 'execute') as ok`,
          [role],
        )
        expect(rows[0]?.ok, role).toBe(false)
      }
      const { rows } = await db.sql.query<{ ok: boolean }>(
        `select has_function_privilege('service_role', 'earth.rate_limit_reset(text, text)', 'execute') as ok`,
      )
      expect(rows[0]?.ok).toBe(true)
      const viaService = await db.asRole('service', (c) =>
        c.query<{ n: number }>(`select earth.rate_limit_reset('nobody') as n`),
      )
      expect(Number(viaService.rows[0]?.n)).toBe(0)
    })

    it('refuses non-service callers even through a security definer wrapper', async () => {
      expect(await errorCode(db.rpc('probe_reset', { subject: alice.userId }, alice.as))).toBe(
        'forbidden',
      )
      expect(await errorCode(db.rpc('probe_reset', { subject: 'anon' }, 'visitor'))).toBe(
        'forbidden',
      )
      expect(
        await errorCode(
          db.rpc('probe_reset', { subject: alice.userId }, (await createGuest(db)).as),
        ),
      ).toBe('forbidden')
    })

    it('validates its arguments', async () => {
      expect(await errorCode(db.sql.query(`select earth.rate_limit_reset(null)`))).toBe(
        'invalid_input',
      )
      expect(await errorCode(db.sql.query(`select earth.rate_limit_reset('')`))).toBe(
        'invalid_input',
      )
      expect(await errorCode(db.sql.query(`select earth.rate_limit_reset('x', 'a:b')`))).toBe(
        'invalid_input',
      )
    })

    it('clears the windows of one subject (all actions or one), leaving other subjects alone', async () => {
      const bob = await human(db, 'Bob')
      const at = secondsFromNow(0)
      for (let i = 0; i < 3; i += 1)
        await rpcAt(db, 'probe_limited', { max_count: 3 }, alice.as, at)
      expect(await errorCode(rpcAt(db, 'probe_limited', { max_count: 3 }, alice.as, at))).toBe(
        'rate_limited',
      )
      await rpcAt(db, 'probe_limited', { max_count: 3 }, bob.as, at)
      await db.rpc('scope_set', { surface: 'home', scope: 'world' }, alice.as)
      expect(await resetRateLimitsFor(db, alice.userId, 'probe')).toBe(1)
      expect(await errorCode(rpcAt(db, 'probe_limited', { max_count: 3 }, alice.as, at))).toBeNull()
      expect(await resetRateLimitsFor(db, alice.userId)).toBe(2) // probe + scope_set
      expect(await resetRateLimitsFor(db, alice.userId)).toBe(0)
      // Bob's window is untouched: two more attempts fit, the fourth does not.
      await rpcAt(db, 'probe_limited', { max_count: 3 }, bob.as, at)
      await rpcAt(db, 'probe_limited', { max_count: 3 }, bob.as, at)
      expect(await errorCode(rpcAt(db, 'probe_limited', { max_count: 3 }, bob.as, at))).toBe(
        'rate_limited',
      )
    })

    it('resets the shared visitor key and a client address', async () => {
      const at = secondsFromNow(0)
      await db.asRole('visitor', async (c) => {
        await c.query(`select set_config('earth.now', $1, true)`, [at])
        await c.query(
          `select set_config('request.headers', '{"cf-connecting-ip": "203.0.113.9"}', true)`,
        )
        await c.query('select public.probe_limited(2)')
      })
      await db.asRole('visitor', async (c) => {
        await c.query(`select set_config('earth.now', $1, true)`, [at])
        await c.query('select public.probe_limited(2)')
      })
      // Without a trusted header the visitor is keyed by the socket peer (PostgREST in production, this
      // test's connection here), and by the shared 'anon' key only when even that is unknown.
      const { rows: peer } = await db.sql.query<{ subject: string }>(
        `select coalesce(host(inet_client_addr()), 'anon') as subject`,
      )
      const peerSubject = peer[0]?.subject ?? 'anon'
      const { rows } = await db.sql.query<{ key: string }>(
        `select key from private.rate_limits where key like 'probe:%' order by key`,
      )
      expect(rows.map((r) => r.key)).toEqual(
        expect.arrayContaining(['probe:203.0.113.9', `probe:${peerSubject}`]),
      )
      expect(await resetRateLimitsFor(db, '203.0.113.9')).toBe(1)
      expect(await resetRateLimitsFor(db, peerSubject)).toBe(1)
      expect(await resetRateLimitsFor(db, '203.0.113.9')).toBe(0)
    })
  })

  describe('earth.rate_limit_for_caller budgets by caller kind', () => {
    it('Guests and Visitors get ceil(max / 2); Humans the full budget; the service is never limited', async () => {
      const carol = await human(db, 'Carol')
      const guest = await createGuest(db)
      const at = secondsFromNow(0)
      for (let i = 0; i < 4; i += 1)
        await rpcAt(db, 'probe_limited', { max_count: 4 }, carol.as, at)
      expect(await errorCode(rpcAt(db, 'probe_limited', { max_count: 4 }, carol.as, at))).toBe(
        'rate_limited',
      )
      for (let i = 0; i < 2; i += 1)
        await rpcAt(db, 'probe_limited', { max_count: 4 }, guest.as, at)
      expect(await errorCode(rpcAt(db, 'probe_limited', { max_count: 4 }, guest.as, at))).toBe(
        'rate_limited',
      )
      // An odd budget rounds up so a positive limit never becomes zero.
      const guest2 = await createGuest(db)
      await rpcAt(db, 'probe_limited', { max_count: 1 }, guest2.as, at)
      expect(await errorCode(rpcAt(db, 'probe_limited', { max_count: 1 }, guest2.as, at))).toBe(
        'rate_limited',
      )
      for (let i = 0; i < 10; i += 1)
        expect(await db.rpc('probe_limited', { max_count: 1 }, 'service')).toBe(1)
    })

    it('a refused attempt does not extend the window', async () => {
      const dave = await human(db, 'Dave')
      const at = secondsFromNow(0)
      await rpcAt(db, 'probe_limited', { max_count: 1 }, dave.as, at)
      expect(await errorCode(rpcAt(db, 'probe_limited', { max_count: 1 }, dave.as, at))).toBe(
        'rate_limited',
      )
      const { rows } = await db.sql.query<{ count: number }>(
        `select count from private.rate_limits where key = $1`,
        [`probe:${dave.userId}`],
      )
      expect(Number(rows[0]?.count)).toBe(1)
      let failure: unknown
      try {
        await db.sql.query(`select earth.rate_limit_reset('x', 'a:b')`)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(pg.DatabaseError)
    })
  })
})
