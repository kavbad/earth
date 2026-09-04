/**
 * Keeps scripts/local-stack/env.sh honest: its ports mirror @earth/config LOCAL_PORTS and
 * supabase/config.toml, the keys it mints verify with the shared secret, and the dotenv it writes
 * carries what the apps and e2e need (nothing internal, nothing that could leak into Next.js).
 * Also guards the one supabase/config.toml value the Supabase CLI itself validates, because a bad
 * one takes the deploy workflow's `supabase db push` down with it.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { LOCAL_HOST, LOCAL_PORTS } from '../../packages/config/src/constants'
import { DEFAULT_PORTS, PREFIXES } from './gateway.mjs'
import { AUTHENTICATED_AUDIENCE, AUTHENTICATED_ROLE, ApiKeyRoles, verifyJwt } from './jwt'
import { DEFAULT_MAILPIT_URL, OTP_ATTRIBUTE, OTP_LENGTH } from './otp'

const STACK_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(STACK_DIR, '../..')
const ENV_SH = path.join(STACK_DIR, 'env.sh')
const SUPABASE_CONFIG = path.join(REPO_ROOT, 'supabase', 'config.toml')
const TEMPLATES_DIR = path.join(STACK_DIR, 'mail-templates')

/** Minimum enforced by @earth/config `SUPABASE_JWT_SECRET_MIN_LENGTH` (packages/config/src/env.ts). */
const JWT_SECRET_MIN_LENGTH = 32

/**
 * Postgres majors Supabase hosts, i.e. the only values the CLI accepts for `[db] major_version`.
 * Anything else (16 included) aborts every CLI command with `LegacyDbConfigLoadError: Failed
 * reading config: Invalid db.major_version`, so `supabase link` and `supabase db push` in
 * .github/workflows/deploy.yml can never run.
 */
const SUPABASE_DB_MAJOR_VERSIONS = [15, 17]

/** The major the hosted project runs and the deploy workflow pushes migrations to. */
const HOSTED_DB_MAJOR_VERSION = 17

/** `: "${NAME:=value}"` defaults declared in env.sh. */
function shellDefaults(source: string): Record<string, string> {
  const defaults: Record<string, string> = {}
  for (const match of source.matchAll(/^: "\$\{([A-Z0-9_]+):=([^}]*)\}"/gm)) {
    defaults[match[1] as string] = match[2] as string
  }
  return defaults
}

/** `export NAME="value"` literals declared in env.sh. */
function shellExports(source: string): Record<string, string> {
  const exports: Record<string, string> = {}
  for (const match of source.matchAll(/^export ([A-Z0-9_]+)="([^"$]*)"$/gm)) {
    exports[match[1] as string] = match[2] as string
  }
  return exports
}

/** Minimal TOML lookup: `key = value` inside `[section]`. */
function tomlValue(toml: string, section: string, key: string): string {
  const lines = toml.split('\n')
  let inSection = false
  for (const line of lines) {
    const header = /^\[([^\]]+)\]/.exec(line)
    if (header) {
      inSection = header[1] === section
      continue
    }
    if (!inSection) continue
    const pair = new RegExp(`^${key}\\s*=\\s*(.+?)\\s*(#.*)?$`).exec(line)
    if (pair?.[1] !== undefined) return pair[1].replace(/^"|"$/g, '')
  }
  throw new Error(`${section}.${key} not found in supabase/config.toml`)
}

function parseDotenv(text: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf('=')
    expect(index).toBeGreaterThan(0)
    values[line.slice(0, index)] = line.slice(index + 1)
  }
  return values
}

describe('env.sh defaults', () => {
  let envSh: string
  let toml: string
  let defaults: Record<string, string>
  let literals: Record<string, string>

  beforeAll(async () => {
    envSh = await readFile(ENV_SH, 'utf8')
    toml = await readFile(SUPABASE_CONFIG, 'utf8')
    defaults = shellDefaults(envSh)
    literals = shellExports(envSh)
  })

  it('pins the ports of @earth/config LOCAL_PORTS', () => {
    expect(Number(defaults['EARTH_PORT_WEB'])).toBe(LOCAL_PORTS.web)
    expect(Number(defaults['EARTH_PORT_POSTGREST'])).toBe(LOCAL_PORTS.postgrest)
    expect(Number(defaults['EARTH_PORT_GOTRUE'])).toBe(LOCAL_PORTS.gotrue)
    expect(Number(defaults['EARTH_PORT_LIVEKIT'])).toBe(LOCAL_PORTS.livekit)
    expect(Number(defaults['EARTH_PORT_MAILPIT_SMTP'])).toBe(LOCAL_PORTS.mailpitSmtp)
    expect(Number(defaults['EARTH_PORT_MAILPIT_HTTP'])).toBe(LOCAL_PORTS.mailpitHttp)
    expect(defaults['EARTH_STACK_HOST']).toBe(LOCAL_HOST)
  })

  it('uses the Supabase CLI API port for the gateway (supabase/config.toml [api].port)', () => {
    expect(Number(defaults['EARTH_PORT_GATEWAY'])).toBe(Number(tomlValue(toml, 'api', 'port')))
    expect(DEFAULT_PORTS.gateway).toBe(Number(defaults['EARTH_PORT_GATEWAY']))
    expect(DEFAULT_PORTS.postgrest).toBe(LOCAL_PORTS.postgrest)
    expect(DEFAULT_PORTS.gotrue).toBe(LOCAL_PORTS.gotrue)
  })

  it('agrees with otp.ts on the Mailpit port and the OTP length', () => {
    expect(Number(new URL(DEFAULT_MAILPIT_URL).port)).toBe(LOCAL_PORTS.mailpitHttp)
    expect(Number(literals['GOTRUE_MAILER_OTP_LENGTH'])).toBe(OTP_LENGTH)
    expect(Number(tomlValue(toml, 'auth.email', 'otp_length'))).toBe(OTP_LENGTH)
    expect(Number(literals['GOTRUE_MAILER_OTP_EXP'])).toBe(
      Number(tomlValue(toml, 'auth.email', 'otp_expiry')),
    )
    expect(Number(literals['GOTRUE_JWT_EXP'])).toBe(Number(tomlValue(toml, 'auth', 'jwt_expiry')))
    expect(literals['GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED']).toBe(
      tomlValue(toml, 'auth', 'enable_anonymous_sign_ins'),
    )
  })

  it('mirrors the supabase/config.toml [auth] switches the CLI maps onto GoTrue', () => {
    // supabase CLI: GOTRUE_MAILER_AUTOCONFIRM = !enable_confirmations, GOTRUE_DISABLE_SIGNUP = !enable_signup.
    const negate = (value: string): string => String(value !== 'true')
    expect(literals['GOTRUE_MAILER_AUTOCONFIRM']).toBe(
      negate(tomlValue(toml, 'auth.email', 'enable_confirmations')),
    )
    expect(literals['GOTRUE_DISABLE_SIGNUP']).toBe(negate(tomlValue(toml, 'auth', 'enable_signup')))
    expect(literals['GOTRUE_EXTERNAL_EMAIL_ENABLED']).toBe(
      tomlValue(toml, 'auth.email', 'enable_signup'),
    )
    expect(literals['GOTRUE_MAILER_SECURE_EMAIL_CHANGE_ENABLED']).toBe(
      tomlValue(toml, 'auth.email', 'double_confirm_changes'),
    )
    expect(literals['GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED']).toBe(
      tomlValue(toml, 'auth', 'enable_refresh_token_rotation'),
    )
  })

  it('gives every user the authenticated role (the `role` claim PostgREST switches to)', () => {
    // Without GOTRUE_JWT_DEFAULT_GROUP_NAME GoTrue issues tokens with role "" and PostgREST answers
    // 401 `role "" does not exist` for every signed-in user and Guest.
    expect(literals['GOTRUE_JWT_DEFAULT_GROUP_NAME']).toBe(AUTHENTICATED_ROLE)
    expect(literals['GOTRUE_JWT_AUD']).toBe(AUTHENTICATED_AUDIENCE)
  })

  it('ships a dev JWT secret long enough for @earth/config and never exports a bare PORT', () => {
    expect((defaults['EARTH_JWT_SECRET'] ?? '').length).toBeGreaterThanOrEqual(
      JWT_SECRET_MIN_LENGTH,
    )
    expect(envSh).not.toMatch(/^export PORT=/m)
  })

  it('points GoTrue at mail templates that exist and carry the code', async () => {
    // Declared as `export GOTRUE_MAILER_TEMPLATES_<TYPE>="$EARTH_MAIL_TEMPLATES_URL/<name>.html"`.
    const templates = [
      ...envSh.matchAll(
        /^export (GOTRUE_MAILER_TEMPLATES_[A-Z_]+)="\$EARTH_MAIL_TEMPLATES_URL\/([a-z-]+\.html)"$/gm,
      ),
    ]
    expect(templates.map((match) => match[1])).toEqual(
      expect.arrayContaining([
        'GOTRUE_MAILER_TEMPLATES_CONFIRMATION',
        'GOTRUE_MAILER_TEMPLATES_MAGIC_LINK',
        'GOTRUE_MAILER_TEMPLATES_RECOVERY',
        'GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE',
        'GOTRUE_MAILER_TEMPLATES_REAUTHENTICATION',
        'GOTRUE_MAILER_TEMPLATES_INVITE',
      ]),
    )
    expect(envSh).toMatch(new RegExp(`^EARTH_MAIL_TEMPLATES_URL=".*${PREFIXES.templates}"$`, 'm'))
    for (const match of templates) {
      const file = path.join(TEMPLATES_DIR, match[2] as string)
      expect(existsSync(file), `${file} exists`).toBe(true)
      const html = await readFile(file, 'utf8')
      expect(html).toContain('{{ .Token }}')
      expect(html).toContain(`${OTP_ATTRIBUTE}="{{ .Token }}"`)
    }
    const subjectVars = Object.entries(literals).filter(([key]) =>
      key.startsWith('GOTRUE_MAILER_SUBJECTS_'),
    )
    expect(subjectVars.length).toBeGreaterThanOrEqual(6)
    for (const [key, subject] of subjectVars) {
      if (key.endsWith('_INVITE')) continue
      expect(subject, key).toContain('{{ .Token }}')
    }
  })
})

describe('env.sh evaluated', () => {
  let tmpDir: string
  let env: Record<string, string>
  let stackEnv: Record<string, string>
  let toml: string

  beforeAll(async () => {
    toml = await readFile(SUPABASE_CONFIG, 'utf8')
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'earth-env-'))
    const stackEnvFile = path.join(tmpDir, 'stack.env')
    const { stdout } = await promisify(execFile)('bash', ['-c', `source "${ENV_SH}" && env -0`], {
      cwd: tmpDir,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: process.env['HOME'] ?? tmpDir,
        EARTH_STACK_ENV_FILE: stackEnvFile,
      },
      maxBuffer: 4 * 1024 * 1024,
    })
    env = {}
    for (const entry of stdout.split('\0')) {
      const index = entry.indexOf('=')
      if (index > 0) env[entry.slice(0, index)] = entry.slice(index + 1)
    }
    stackEnv = parseDotenv(await readFile(stackEnvFile, 'utf8'))
  }, 30_000)

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('hands the apps the gateway as the Supabase URL, identically for web and mobile', () => {
    const gateway = `http://${LOCAL_HOST}:${DEFAULT_PORTS.gateway}`
    expect(env['NEXT_PUBLIC_SUPABASE_URL']).toBe(gateway)
    expect(env['EARTH_SUPABASE_URL']).toBe(gateway)
    expect(env['API_EXTERNAL_URL']).toBe(`${gateway}${PREFIXES.auth}`)
    for (const key of [
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'API_BASE_URL',
      'LIVEKIT_URL',
      'MAP_STYLE_URL',
      'APP_ENV',
      'WEB_ORIGIN',
    ]) {
      expect(env[`EXPO_PUBLIC_${key}`], key).toBe(env[`NEXT_PUBLIC_${key}`])
      expect(env[`NEXT_PUBLIC_${key}`], key).toBeTruthy()
    }
    expect(env['NEXT_PUBLIC_API_BASE_URL']).toBe(`http://${LOCAL_HOST}:${LOCAL_PORTS.web}`)
    expect(env['NEXT_PUBLIC_LIVEKIT_URL']).toBe(`ws://${LOCAL_HOST}:${LOCAL_PORTS.livekit}`)
    expect(env['E2E_BASE_URL']).toBe(env['NEXT_PUBLIC_WEB_ORIGIN'])
  })

  it('mints anon and service_role keys that verify with the shared secret', () => {
    const secret = env['SUPABASE_JWT_SECRET'] as string
    expect(secret.length).toBeGreaterThanOrEqual(JWT_SECRET_MIN_LENGTH)
    expect(env['GOTRUE_JWT_SECRET']).toBe(secret)
    expect(verifyJwt(env['SUPABASE_ANON_KEY'] as string, secret)).toMatchObject({
      role: ApiKeyRoles.anon,
    })
    expect(verifyJwt(env['SUPABASE_SERVICE_ROLE_KEY'] as string, secret)).toMatchObject({
      role: ApiKeyRoles.serviceRole,
    })
    expect(env['NEXT_PUBLIC_SUPABASE_ANON_KEY']).toBe(env['SUPABASE_ANON_KEY'])
  })

  it('targets earth_local for Postgres, PostgREST (authenticator) and GoTrue (search_path=auth)', () => {
    expect(env['DATABASE_URL']).toBe('postgres://postgres:postgres@127.0.0.1:5432/earth_local')
    expect(env['PGRST_DB_URI']).toBe('postgres://authenticator:postgres@127.0.0.1:5432/earth_local')
    expect(env['GOTRUE_DB_DATABASE_URL']).toBe(`${env['DATABASE_URL']}?search_path=auth`)
    expect(env['GOTRUE_DB_DRIVER']).toBe('postgres')
    expect(env['GOTRUE_DB_MIGRATIONS_PATH']).toBe(
      path.join(REPO_ROOT, '.local', 'gotrue', 'migrations'),
    )
  })

  it('configures GoTrue for guests and email codes through Mailpit', () => {
    expect(env['GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED']).toBe('true')
    expect(env['GOTRUE_EXTERNAL_EMAIL_ENABLED']).toBe('true')
    expect(env['GOTRUE_EXTERNAL_PHONE_ENABLED']).toBe('false')
    expect(env['GOTRUE_MAILER_AUTOCONFIRM']).toBe(
      String(tomlValue(toml, 'auth.email', 'enable_confirmations') !== 'true'),
    )
    expect(env['GOTRUE_JWT_AUD']).toBe('authenticated')
    expect(env['GOTRUE_JWT_ADMIN_ROLES']).toBe(ApiKeyRoles.serviceRole)
    expect(Number(env['GOTRUE_API_PORT'])).toBe(LOCAL_PORTS.gotrue)
    expect(Number(env['GOTRUE_SMTP_PORT'])).toBe(LOCAL_PORTS.mailpitSmtp)
    expect(env['GOTRUE_MAILER_TEMPLATES_MAGIC_LINK']).toBe(
      `http://127.0.0.1:${DEFAULT_PORTS.gateway}${PREFIXES.templates}/magic-link.html`,
    )
    expect(env['GOTRUE_JWT_DEFAULT_GROUP_NAME']).toBe(AUTHENTICATED_ROLE)
    expect(env['GOTRUE_SITE_URL']).toBe(tomlValue(toml, 'auth', 'site_url'))
    expect(env['PORT']).toBeUndefined()
  })

  it('binds GoTrue to the same interface as every other service (loopback by default)', () => {
    expect(env['EARTH_BIND_HOST']).toBe('127.0.0.1')
    expect(env['GOTRUE_API_HOST']).toBe(env['EARTH_BIND_HOST'])
  })

  it('writes .local/stack.env with the app-facing subset only', () => {
    for (const key of [
      'NEXT_PUBLIC_SUPABASE_URL',
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
      'EXPO_PUBLIC_SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_JWT_SECRET',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
      'DATABASE_URL',
      'E2E_BASE_URL',
      'EARTH_MAILPIT_URL',
      'EARTH_PORT_GATEWAY',
    ]) {
      expect(stackEnv[key], key).toBe(env[key])
    }
    expect(Object.keys(stackEnv).some((key) => key.startsWith('GOTRUE_'))).toBe(false)
    expect(stackEnv['PORT']).toBeUndefined()
    expect(stackEnv['PATH']).toBeUndefined()
  })
})

describe('supabase/config.toml', () => {
  it('declares a [db] major_version the Supabase CLI accepts, so `supabase db push` can run', async () => {
    const toml = await readFile(SUPABASE_CONFIG, 'utf8')
    const major = Number(tomlValue(toml, 'db', 'major_version'))
    expect(SUPABASE_DB_MAJOR_VERSIONS).toContain(major)
    expect(major).toBe(HOSTED_DB_MAJOR_VERSION)
  })
})
