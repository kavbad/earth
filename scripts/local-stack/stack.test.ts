/**
 * Live smoke test of the running local stack (scripts/local-stack/up.sh): the things `up.sh`'s
 * health checks cannot see. Anonymous sign-in (Guests, ARCHITECTURE.md §4) through the gateway must
 * yield a token PostgREST accepts as `authenticated`, and an email OTP must reach Mailpit and verify.
 *
 * Configuration comes from .local/stack.env (written by env.sh) with process.env taking precedence.
 * When no gateway answers the suite is skipped — unless EARTH_REQUIRE_STACK=1 (CI's e2e job), in
 * which case an unreachable stack fails the run.
 */
import { parse as parseDotenv } from 'dotenv'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { PREFIXES, UNAVAILABLE_STATUS } from './gateway.mjs'
import {
  AUTHENTICATED_AUDIENCE,
  AUTHENTICATED_ROLE,
  ApiKeyRoles,
  IS_ANONYMOUS_CLAIM,
  decodeJwt,
  isAuthenticatedUserClaims,
  verifyJwt,
  type JwtClaims,
} from './jwt'
import { OTP_LENGTH, latestOtpFor } from './otp'

export const REQUIRE_STACK_ENV = 'EARTH_REQUIRE_STACK'
export const STACK_ENV_FILE_ENV = 'EARTH_STACK_ENV_FILE'
export const DEFAULT_STACK_ENV_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.local/stack.env',
)

/** GoTrue endpoints behind the gateway's /auth/v1 prefix. */
export const AUTH_PATHS = {
  signup: `${PREFIXES.auth}/signup`,
  otp: `${PREFIXES.auth}/otp`,
  verify: `${PREFIXES.auth}/verify`,
} as const

/** Storage's answer to a request with no bearer at all (its own error envelope, not the gateway's). */
export const STORAGE_REFUSED_STATUS = 403

/** `type` accepted by /verify for email codes from both the signup and the magic-link templates. */
export const EMAIL_OTP_VERIFY_TYPE = 'email' as const

export const STACK_CONFIG_KEYS = [
  'EARTH_SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'EARTH_MAILPIT_URL',
] as const
export type StackConfigKey = (typeof STACK_CONFIG_KEYS)[number]
export type StackConfig = Record<StackConfigKey, string>

/**
 * Resolves the stack configuration: the dotenv file (when it exists) overlaid with `env`.
 * Returns `null` when any key is missing so the caller can skip instead of guessing defaults.
 */
export function loadStackConfig(
  env: NodeJS.ProcessEnv,
  stackEnvFile: string = env[STACK_ENV_FILE_ENV] ?? DEFAULT_STACK_ENV_FILE,
): StackConfig | null {
  const fromFile: Record<string, string> = existsSync(stackEnvFile)
    ? parseDotenv(readFileSync(stackEnvFile, 'utf8'))
    : {}
  const config: Partial<StackConfig> = {}
  for (const key of STACK_CONFIG_KEYS) {
    const value = env[key] ?? fromFile[key]
    if (value === undefined || value === '') return null
    config[key] = value
  }
  return config as StackConfig
}

export async function gatewayReachable(supabaseUrl: string, timeoutMs = 2_000): Promise<boolean> {
  try {
    const response = await fetch(`${supabaseUrl}${PREFIXES.health}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return response.ok
  } catch {
    return false
  }
}

interface SessionResponse {
  access_token: string
  token_type: string
  user: { id: string; is_anonymous?: boolean; email?: string }
}

async function postJson(
  url: string,
  apikey: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { apikey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, json: text === '' ? null : (JSON.parse(text) as unknown) }
}

async function restStatus(supabaseUrl: string, apikey: string, bearer: string): Promise<number> {
  const response = await fetch(`${supabaseUrl}${PREFIXES.rest}/`, {
    headers: { apikey, authorization: `Bearer ${bearer}` },
  })
  await response.arrayBuffer()
  return response.status
}

describe('loadStackConfig', () => {
  const complete: StackConfig = {
    EARTH_SUPABASE_URL: 'http://gw:1',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    SUPABASE_JWT_SECRET: 'secret',
    EARTH_MAILPIT_URL: 'http://mail:2',
  }

  it('returns null when a key is missing or empty', () => {
    expect(loadStackConfig({}, '/nonexistent/stack.env')).toBeNull()
    expect(loadStackConfig(complete, '/nonexistent/stack.env')).toEqual(complete)
    expect(loadStackConfig({ ...complete, SUPABASE_JWT_SECRET: '' }, '/nonexistent')).toBeNull()
  })

  it('reads .local/stack.env and lets the environment override it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'earth-stack-test-'))
    try {
      const file = path.join(dir, 'stack.env')
      await writeFile(
        file,
        `# generated\n${Object.entries(complete)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n')}\n`,
      )
      expect(loadStackConfig({}, file)).toEqual(complete)
      expect(loadStackConfig({ EARTH_MAILPIT_URL: 'http://override:3' }, file)).toEqual({
        ...complete,
        EARTH_MAILPIT_URL: 'http://override:3',
      })
      expect(loadStackConfig({ [STACK_ENV_FILE_ENV]: file })).toEqual(complete)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

const config = loadStackConfig(process.env)
const required = process.env[REQUIRE_STACK_ENV] === '1'
const stackUp = config !== null && (await gatewayReachable(config.EARTH_SUPABASE_URL))
if (!stackUp && !required) {
  console.warn(
    `[stack.test] no local stack at ${config?.EARTH_SUPABASE_URL ?? '(no .local/stack.env)'}; skipping the live suite (pnpm stack:up starts it)`,
  )
}

it.runIf(required)(`the local stack must be running when ${REQUIRE_STACK_ENV}=1`, () => {
  expect(config, '.local/stack.env or the EARTH_* variables are missing').not.toBeNull()
  expect(stackUp, `no gateway at ${config?.EARTH_SUPABASE_URL}; run pnpm stack:up`).toBe(true)
})

describe.runIf(stackUp)('local stack (live)', () => {
  // `describe.runIf(false)` still evaluates this body to collect the tests it holds; only the
  // running is skipped. So nothing out here may dereference `config`, which is null whenever the
  // stack is down — a fresh clone and CI both have no `.local/stack.env`. The `it` bodies below
  // run only when `stackUp` is true, so reading the real values inside them is safe.
  const stack = (config ?? {}) as StackConfig
  const base = stack.EARTH_SUPABASE_URL ?? ''
  let guestToken = ''

  it('gateway health names both upstreams', async () => {
    const response = await fetch(`${base}${PREFIXES.health}`)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      upstreams: { rest: expect.anything(), auth: expect.anything() },
    })
  })

  it(`anonymous sign-in issues a Guest token: ${IS_ANONYMOUS_CLAIM}=true, role=${AUTHENTICATED_ROLE}, signed with the shared secret`, async () => {
    const { status, json } = await postJson(
      `${base}${AUTH_PATHS.signup}`,
      stack.SUPABASE_ANON_KEY,
      {},
    )
    expect(status, JSON.stringify(json)).toBe(200)
    const session = json as SessionResponse
    expect(session.user.is_anonymous).toBe(true)
    guestToken = session.access_token

    const claims: JwtClaims = verifyJwt(guestToken, stack.SUPABASE_JWT_SECRET)
    expect(isAuthenticatedUserClaims(claims), JSON.stringify(claims)).toBe(true)
    expect(claims).toMatchObject({
      role: AUTHENTICATED_ROLE,
      aud: AUTHENTICATED_AUDIENCE,
      iss: `${base}${PREFIXES.auth}`,
      sub: session.user.id,
      [IS_ANONYMOUS_CLAIM]: true,
    })
  })

  it('PostgREST (through /rest/v1) accepts the API keys and the Guest token, rejects a forged one', async () => {
    expect(guestToken, 'anonymous sign-in must have succeeded').not.toBe('')
    expect(decodeJwt(stack.SUPABASE_ANON_KEY).claims['role']).toBe(ApiKeyRoles.anon)
    expect(decodeJwt(stack.SUPABASE_SERVICE_ROLE_KEY).claims['role']).toBe(ApiKeyRoles.serviceRole)

    await expect(restStatus(base, stack.SUPABASE_ANON_KEY, stack.SUPABASE_ANON_KEY)).resolves.toBe(
      200,
    )
    await expect(
      restStatus(base, stack.SUPABASE_SERVICE_ROLE_KEY, stack.SUPABASE_SERVICE_ROLE_KEY),
    ).resolves.toBe(200)
    await expect(restStatus(base, stack.SUPABASE_ANON_KEY, guestToken)).resolves.toBe(200)

    const forged = `${guestToken.slice(0, guestToken.lastIndexOf('.'))}.AAAA`
    await expect(restStatus(base, stack.SUPABASE_ANON_KEY, forged)).resolves.toBe(401)
  })

  it('email OTP: /otp sends a code through Mailpit that otp.ts reads and /verify accepts', async () => {
    const email = `smoke-${Date.now()}-${process.pid}@earth.local`
    const requested = await postJson(`${base}${AUTH_PATHS.otp}`, stack.SUPABASE_ANON_KEY, {
      email,
      create_user: true,
    })
    expect(requested.status, JSON.stringify(requested.json)).toBe(200)

    const otp = await latestOtpFor(stack.EARTH_MAILPIT_URL, email, { timeoutMs: 20_000 })
    expect(otp, `no OTP email for ${email} at ${stack.EARTH_MAILPIT_URL}`).not.toBeNull()
    expect(otp?.code).toMatch(new RegExp(`^\\d{${OTP_LENGTH}}$`))
    expect(otp?.subject).toContain(otp?.code)

    const verified = await postJson(`${base}${AUTH_PATHS.verify}`, stack.SUPABASE_ANON_KEY, {
      type: EMAIL_OTP_VERIFY_TYPE,
      email,
      token: otp?.code,
    })
    expect(verified.status, JSON.stringify(verified.json)).toBe(200)
    const session = verified.json as SessionResponse
    expect(session.user.email).toBe(email)
    const claims = verifyJwt(session.access_token, stack.SUPABASE_JWT_SECRET)
    expect(isAuthenticatedUserClaims(claims)).toBe(true)
    expect(claims).toMatchObject({
      role: AUTHENTICATED_ROLE,
      email,
      [IS_ANONYMOUS_CLAIM]: false,
    })
  }, 45_000)

  it('Storage is served by the stack and refuses an uncredentialed upload', async () => {
    // scripts/local-stack/storage.mjs, mounted on the gateway: it answers (no longer 501) and the
    // 0997 policies decide. The round trip itself is covered by scripts/local-stack/storage.test.ts.
    const upload = await fetch(`${base}${PREFIXES.storage}/object/media/nobody/a.png`, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: 'not-a-png',
    })
    expect(upload.status).toBe(STORAGE_REFUSED_STATUS)
    await expect(upload.json()).resolves.toMatchObject({ error: 'Unauthorized' })

    const missing = await fetch(`${base}${PREFIXES.storage}/object/public/avatars/nobody/a.png`)
    expect(missing.status).toBe(404)
    await missing.arrayBuffer()
  })

  it('Realtime answers with its documented unavailable status', async () => {
    const realtime = await fetch(`${base}${PREFIXES.realtime}/api/broadcast`, {
      method: 'POST',
      body: '{}',
    })
    expect(realtime.status).toBe(UNAVAILABLE_STATUS.realtime)
    await realtime.arrayBuffer()
  })
})
