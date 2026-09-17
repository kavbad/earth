import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  API_KEY_ROLES,
  ApiKeyRoles,
  JWT_ALGORITHM,
  LOCAL_KEY_ISSUED_AT,
  LOCAL_KEY_LIFETIME_SECONDS,
  LOCAL_PROJECT_REF,
  SUPABASE_JWT_ISSUER,
  base64UrlDecode,
  base64UrlEncode,
  decodeJwt,
  mintApiKey,
  mintJwt,
  parseCliArgs,
  runCli,
  supabaseApiKeyClaims,
  verifyJwt,
} from './jwt'

const SECRET = 'earth-local-dev-jwt-secret-please-change-0000'
const OTHER_SECRET = 'another-secret-that-is-also-long-enough-0000'

describe('base64url', () => {
  it('round-trips without padding characters', () => {
    const encoded = base64UrlEncode('{"a":"?>"}')
    expect(encoded).not.toMatch(/[=+/]/)
    expect(base64UrlDecode(encoded).toString('utf8')).toBe('{"a":"?>"}')
  })
})

describe('mintJwt / verifyJwt', () => {
  it('produces a three-part HS256 token whose signature matches node:crypto', () => {
    const token = mintJwt({ role: ApiKeyRoles.anon }, SECRET)
    const [header, claims, signature] = token.split('.') as [string, string, string]
    expect(JSON.parse(base64UrlDecode(header).toString())).toEqual({
      alg: JWT_ALGORITHM,
      typ: 'JWT',
    })
    expect(JSON.parse(base64UrlDecode(claims).toString())).toEqual({ role: 'anon' })
    const expected = createHmac('sha256', SECRET).update(`${header}.${claims}`).digest('base64url')
    expect(signature).toBe(expected)
  })

  it('verifies with the right secret and rejects the wrong one', () => {
    const token = mintJwt({ role: ApiKeyRoles.serviceRole, exp: 4_102_444_800 }, SECRET)
    expect(verifyJwt(token, SECRET)).toEqual({ role: 'service_role', exp: 4_102_444_800 })
    expect(() => verifyJwt(token, OTHER_SECRET)).toThrow(/signature/)
  })

  it('rejects tampered claims and malformed tokens', () => {
    const token = mintJwt({ role: ApiKeyRoles.anon }, SECRET)
    const [header, , signature] = token.split('.') as [string, string, string]
    const forged = `${header}.${base64UrlEncode(JSON.stringify({ role: 'service_role' }))}.${signature}`
    expect(() => verifyJwt(forged, SECRET)).toThrow(/signature/)
    expect(() => decodeJwt('not-a-jwt')).toThrow(/three/)
  })

  it('rejects a non-HS256 header even with a valid-looking signature', () => {
    const header = base64UrlEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    const claims = base64UrlEncode(JSON.stringify({ role: 'anon' }))
    expect(() => verifyJwt(`${header}.${claims}.`, SECRET)).toThrow(/algorithm/)
  })

  it('refuses short secrets', () => {
    expect(() => mintJwt({ role: ApiKeyRoles.anon }, 'short')).toThrow(/32/)
  })
})

describe('supabaseApiKeyClaims / mintApiKey', () => {
  it('shapes claims like Supabase project keys and is deterministic', () => {
    expect(supabaseApiKeyClaims(ApiKeyRoles.anon)).toEqual({
      iss: SUPABASE_JWT_ISSUER,
      ref: LOCAL_PROJECT_REF,
      role: 'anon',
      iat: LOCAL_KEY_ISSUED_AT,
      exp: LOCAL_KEY_ISSUED_AT + LOCAL_KEY_LIFETIME_SECONDS,
    })
    expect(mintApiKey(ApiKeyRoles.anon, SECRET)).toBe(mintApiKey(ApiKeyRoles.anon, SECRET))
    expect(mintApiKey(ApiKeyRoles.anon, SECRET)).not.toBe(
      mintApiKey(ApiKeyRoles.serviceRole, SECRET),
    )
  })

  it('mints every API role with a far-future expiry', () => {
    for (const role of API_KEY_ROLES) {
      const claims = verifyJwt(mintApiKey(role, SECRET), SECRET)
      expect(claims['role']).toBe(role)
      expect(claims['exp']).toBeGreaterThan(Date.now() / 1000 + 365 * 24 * 3600)
    }
  })

  it('honours explicit issue time, lifetime and ref', () => {
    const claims = supabaseApiKeyClaims(ApiKeyRoles.serviceRole, {
      issuedAt: 1_000,
      lifetimeSeconds: 60,
      ref: 'abc',
    })
    expect(claims).toMatchObject({ iat: 1_000, exp: 1_060, ref: 'abc' })
  })
})

describe('cli', () => {
  it('parses commands, flags and the secret from the environment', () => {
    expect(parseCliArgs(['mint', 'anon'], { SUPABASE_JWT_SECRET: SECRET })).toMatchObject({
      command: 'mint',
      subject: 'anon',
      secret: SECRET,
    })
    expect(
      parseCliArgs(['mint', 'anon', '--secret', 'x', '--issued-at', '5', '--lifetime', '7'], {}),
    ).toMatchObject({ secret: 'x', issuedAt: 5, lifetimeSeconds: 7 })
    expect(parseCliArgs([], {})).toMatchObject({ command: 'help' })
    expect(() => parseCliArgs(['--bogus'], {})).toThrow(/Unknown argument/)
    expect(() => parseCliArgs(['explode'], {})).toThrow(/Unknown command/)
    expect(() => parseCliArgs(['mint', 'anon', '--secret'], {})).toThrow(/needs a value/)
  })

  it('mints, decodes and verifies through runCli', () => {
    const token = runCli(['mint', 'service_role'], { SUPABASE_JWT_SECRET: SECRET })
    expect(token).toBe(mintApiKey(ApiKeyRoles.serviceRole, SECRET))
    expect(JSON.parse(runCli(['decode', token], {}))).toMatchObject({ role: 'service_role' })
    expect(JSON.parse(runCli(['verify', token, '--secret', SECRET], {}))).toMatchObject({
      role: 'service_role',
    })
    expect(() => runCli(['verify', token, '--secret', OTHER_SECRET], {})).toThrow(/signature/)
    expect(() => runCli(['mint', 'postgres'], { SUPABASE_JWT_SECRET: SECRET })).toThrow(/role/)
    expect(() => runCli(['mint', 'anon'], {})).toThrow(/SUPABASE_JWT_SECRET/)
    expect(runCli(['--help'], {})).toMatch(/usage/)
  })
})
