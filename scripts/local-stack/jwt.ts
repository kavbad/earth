#!/usr/bin/env tsx
/**
 * HS256 JSON Web Tokens with nothing but node:crypto.
 *
 * The local stack signs its own Supabase-shaped API keys (`anon`, `service_role`) with the dev JWT
 * secret so PostgREST, GoTrue and the apps agree on one secret (scripts/local-stack/env.sh), and
 * e2e helpers decode the tokens GoTrue issues (`is_anonymous`, `role`). Not a general JWT library.
 *
 *   tsx scripts/local-stack/jwt.ts mint <anon|service_role> [--secret <s>] [--issued-at <epoch>] [--lifetime <s>]
 *   tsx scripts/local-stack/jwt.ts decode <token>               prints the claims as JSON
 *   tsx scripts/local-stack/jwt.ts verify <token> [--secret <s>] exits 1 when the signature is wrong
 *
 * The secret comes from --secret, else SUPABASE_JWT_SECRET.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const JWT_ALGORITHM = 'HS256' as const
export const JWT_TYPE = 'JWT' as const

/** `iss` and `ref` Supabase puts on project API keys; `ref` is the project ref (here: local). */
export const SUPABASE_JWT_ISSUER = 'supabase' as const
export const LOCAL_PROJECT_REF = 'local' as const

/** Roles PostgREST switches to; the `role` claim of an API key (ARCHITECTURE.md §4, §5). */
export const API_KEY_ROLES = ['anon', 'service_role'] as const
export type ApiKeyRole = (typeof API_KEY_ROLES)[number]
export const ApiKeyRoles = { anon: 'anon', serviceRole: 'service_role' } as const satisfies Record<
  string,
  ApiKeyRole
>

/**
 * `role` claim GoTrue puts on every user token, anonymous (Guest) or not, and stores in
 * `auth.users.role` (GOTRUE_JWT_DEFAULT_GROUP_NAME in env.sh). PostgREST switches to this database
 * role, so every `to authenticated` policy and `earth.current_role_kind()` depend on it (§4).
 */
export const AUTHENTICATED_ROLE = 'authenticated' as const
/** `aud` claim of user tokens (GOTRUE_JWT_AUD) and PostgREST's `jwt-aud`. */
export const AUTHENTICATED_AUDIENCE = 'authenticated' as const
/** Claim GoTrue sets to `true` on anonymous sign-ins (ARCHITECTURE.md §4: Guests). */
export const IS_ANONYMOUS_CLAIM = 'is_anonymous' as const

/** Claims of a token GoTrue issued to a user, as far as the local stack relies on them. */
export interface UserTokenClaims extends JwtClaims {
  sub: string
  role: string
  aud: string
  iss: string
  [IS_ANONYMOUS_CLAIM]: boolean
}

/** True when `claims` are usable by PostgREST as an authenticated user or Guest (§4). */
export function isAuthenticatedUserClaims(claims: JwtClaims): claims is UserTokenClaims {
  return (
    typeof claims['sub'] === 'string' &&
    claims['role'] === AUTHENTICATED_ROLE &&
    claims['aud'] === AUTHENTICATED_AUDIENCE &&
    typeof claims['iss'] === 'string' &&
    typeof claims[IS_ANONYMOUS_CLAIM] === 'boolean'
  )
}

/** Fixed issue time so the minted keys are byte-identical across runs (stable .local/stack.env). */
export const LOCAL_KEY_ISSUED_AT = Math.floor(Date.UTC(2025, 0, 1) / 1000)
/** Ten years: a dev key must never expire under a running stack. */
export const LOCAL_KEY_LIFETIME_SECONDS = 10 * 365 * 24 * 60 * 60

export interface JwtHeader {
  alg: typeof JWT_ALGORITHM
  typ: typeof JWT_TYPE
}

export type JwtClaims = Record<string, unknown>

export interface SupabaseApiKeyClaims extends JwtClaims {
  iss: typeof SUPABASE_JWT_ISSUER
  ref: string
  role: ApiKeyRole
  iat: number
  exp: number
}

export interface MintOptions {
  issuedAt?: number
  lifetimeSeconds?: number
  ref?: string
}

export function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

export function base64UrlDecode(input: string): Buffer {
  return Buffer.from(input, 'base64url')
}

export function isApiKeyRole(value: string): value is ApiKeyRole {
  return (API_KEY_ROLES as readonly string[]).includes(value)
}

/** Claims of a Supabase API key for `role`, deterministic unless `issuedAt` is given. */
export function supabaseApiKeyClaims(
  role: ApiKeyRole,
  options: MintOptions = {},
): SupabaseApiKeyClaims {
  const iat = options.issuedAt ?? LOCAL_KEY_ISSUED_AT
  const lifetime = options.lifetimeSeconds ?? LOCAL_KEY_LIFETIME_SECONDS
  return {
    iss: SUPABASE_JWT_ISSUER,
    ref: options.ref ?? LOCAL_PROJECT_REF,
    role,
    iat,
    exp: iat + lifetime,
  }
}

function sign(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url')
}

/** Signs `claims` with HS256. The secret must be at least 32 characters (Supabase's own minimum). */
export function mintJwt(claims: JwtClaims, secret: string): string {
  if (secret.length < 32) throw new Error('JWT secret must be at least 32 characters')
  const header: JwtHeader = { alg: JWT_ALGORITHM, typ: JWT_TYPE }
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`
  return `${signingInput}.${sign(signingInput, secret)}`
}

/** Mints the local `anon` or `service_role` API key. */
export function mintApiKey(role: ApiKeyRole, secret: string, options: MintOptions = {}): string {
  return mintJwt(supabaseApiKeyClaims(role, options), secret)
}

export interface DecodedJwt {
  header: JwtHeader
  claims: JwtClaims
  signingInput: string
  signature: string
}

/** Splits and base64url-decodes a token without checking the signature. */
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('Malformed JWT: expected three dot-separated parts')
  const [rawHeader, rawClaims, signature] = parts as [string, string, string]
  const header = JSON.parse(base64UrlDecode(rawHeader).toString('utf8')) as JwtHeader
  const claims = JSON.parse(base64UrlDecode(rawClaims).toString('utf8')) as JwtClaims
  return { header, claims, signingInput: `${rawHeader}.${rawClaims}`, signature }
}

/** Verifies an HS256 signature (constant time) and returns the claims; throws otherwise. */
export function verifyJwt(token: string, secret: string): JwtClaims {
  const decoded = decodeJwt(token)
  if (decoded.header.alg !== JWT_ALGORITHM) {
    throw new Error(`Unsupported JWT algorithm: ${String(decoded.header.alg)}`)
  }
  const expected = Buffer.from(sign(decoded.signingInput, secret))
  const actual = Buffer.from(decoded.signature)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('JWT signature does not match the secret')
  }
  return decoded.claims
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

export interface CliOptions {
  command: 'mint' | 'decode' | 'verify' | 'help'
  subject: string | undefined
  secret: string | undefined
  issuedAt: number | undefined
  lifetimeSeconds: number | undefined
}

export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliOptions {
  const options: CliOptions = {
    command: 'help',
    subject: undefined,
    secret: env['SUPABASE_JWT_SECRET'],
    issuedAt: undefined,
    lifetimeSeconds: undefined,
  }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string
    const next = (): string => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${arg} needs a value`)
      i += 1
      return value
    }
    switch (arg) {
      case '--secret':
        options.secret = next()
        break
      case '--issued-at':
        options.issuedAt = Number(next())
        break
      case '--lifetime':
        options.lifetimeSeconds = Number(next())
        break
      case '--help':
      case '-h':
        options.command = 'help'
        return options
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`)
        positional.push(arg)
    }
  }
  const [command, subject] = positional
  if (command === 'mint' || command === 'decode' || command === 'verify') {
    options.command = command
    options.subject = subject
  } else if (command !== undefined) {
    throw new Error(`Unknown command: ${command}`)
  }
  return options
}

export function runCli(argv: readonly string[], env: NodeJS.ProcessEnv): string {
  const options = parseCliArgs(argv, env)
  switch (options.command) {
    case 'help':
      return [
        'usage: tsx scripts/local-stack/jwt.ts mint <anon|service_role> [--secret <s>] [--issued-at <epoch>] [--lifetime <s>]',
        '       tsx scripts/local-stack/jwt.ts decode <token>',
        '       tsx scripts/local-stack/jwt.ts verify <token> [--secret <s>]',
        'The secret defaults to SUPABASE_JWT_SECRET.',
      ].join('\n')
    case 'mint': {
      if (options.subject === undefined || !isApiKeyRole(options.subject)) {
        throw new Error(`mint needs a role: ${API_KEY_ROLES.join(' | ')}`)
      }
      if (options.secret === undefined)
        throw new Error('mint needs --secret or SUPABASE_JWT_SECRET')
      const mintOptions: MintOptions = {}
      if (options.issuedAt !== undefined) mintOptions.issuedAt = options.issuedAt
      if (options.lifetimeSeconds !== undefined)
        mintOptions.lifetimeSeconds = options.lifetimeSeconds
      return mintApiKey(options.subject, options.secret, mintOptions)
    }
    case 'decode': {
      if (options.subject === undefined) throw new Error('decode needs a token')
      return JSON.stringify(decodeJwt(options.subject).claims)
    }
    case 'verify': {
      if (options.subject === undefined) throw new Error('verify needs a token')
      if (options.secret === undefined)
        throw new Error('verify needs --secret or SUPABASE_JWT_SECRET')
      return JSON.stringify(verifyJwt(options.subject, options.secret))
    }
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    console.log(runCli(process.argv.slice(2), process.env))
  } catch (error) {
    console.error(`[jwt] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
