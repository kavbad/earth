/**
 * Keeps the root `.env.example` in lockstep with the schemas: every variable documented, none
 * unknown, placeholders that load cleanly through both schemas, and placeholders that cannot be
 * promoted to production by flipping APP_ENV alone.
 */
import { describe, expect, it } from 'vitest'

import {
  AppEnvs,
  DEFAULT_ROOM_GRACE_SECONDS,
  describeEnv,
  EnvError,
  HumanVerificationProviders,
  loadPublicEnv,
  loadServerEnv,
  PUBLIC_APP_ENV_VARIABLES,
  PUBLIC_DEVELOPMENT_DEFAULT_KEYS,
  PUBLIC_ENV_KEYS,
  PUBLIC_ENV_PREFIXES,
  PublicEnvPrefixes,
  publicEnvVariableName,
  SERVER_ENV_KEYS,
  SERVER_SECRET_KEYS,
} from './env'
import { DEPLOY_ENV_KEYS, parseDotenv, readRepoFile, TOOLING_ENV_KEYS } from './testing'

const ENV_EXAMPLE = '.env.example'
const text = readRepoFile(ENV_EXAMPLE)
const example = parseDotenv(text)
const exampleKeys = Object.keys(example)
const description = describeEnv()

function isDeployKey(key: string): boolean {
  return (DEPLOY_ENV_KEYS as readonly string[]).includes(key)
}

function catchEnvError(fn: () => unknown): EnvError {
  try {
    fn()
  } catch (error) {
    if (error instanceof EnvError) return error
    throw error
  }
  throw new Error('expected an EnvError')
}

describe('.env.example', () => {
  it.each(PUBLIC_ENV_PREFIXES)(
    'documents every public variable under %s, in schema order',
    (prefix) => {
      const expected = PUBLIC_ENV_KEYS.map((key) => publicEnvVariableName(key, prefix))
      const actual = exampleKeys.filter((key) => key.startsWith(prefix) && !isDeployKey(key))
      expect(actual).toEqual(expected)
    },
  )

  it('documents every server variable in schema order and nothing unknown', () => {
    const actual = exampleKeys.filter(
      (key) => !PUBLIC_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)),
    )
    expect(
      actual.filter(
        (key) => !(TOOLING_ENV_KEYS as readonly string[]).includes(key) && !isDeployKey(key),
      ),
    ).toEqual([...SERVER_ENV_KEYS])
    for (const key of TOOLING_ENV_KEYS) expect(exampleKeys).toContain(key)
  })

  it('documents every deploy-time variable, and none of them is a schema key', () => {
    const schemaKeys = new Set<string>([
      ...SERVER_ENV_KEYS,
      ...PUBLIC_ENV_PREFIXES.flatMap((prefix) =>
        PUBLIC_ENV_KEYS.map((key) => publicEnvVariableName(key, prefix)),
      ),
    ])
    for (const key of DEPLOY_ENV_KEYS) {
      expect(exampleKeys, key).toContain(key)
      expect(schemaKeys.has(key), `${key} is a deploy input, not a validated variable`).toBe(false)
    }
  })

  it('has a comment above each web public and server variable', () => {
    const lines = text.split('\n')
    const documented = [
      ...PUBLIC_ENV_KEYS.map((key) => publicEnvVariableName(key, PublicEnvPrefixes.web)),
      ...SERVER_ENV_KEYS,
      ...DEPLOY_ENV_KEYS,
    ]
    for (const key of documented) {
      const index = lines.findIndex((line) => line.startsWith(`${key}=`))
      expect(index, key).toBeGreaterThan(0)
      // LiveKit key/secret and vendor settings share a comment block; walk back over bare assignments.
      let cursor = index - 1
      while (cursor >= 0 && /^[A-Z0-9_]+=/.test(lines[cursor] ?? '')) cursor -= 1
      expect(lines[cursor], `${key} needs a comment above it`).toMatch(/^#/)
    }
  })

  it('carries identical values in the web and mobile public blocks', () => {
    for (const key of PUBLIC_ENV_KEYS) {
      expect(example[publicEnvVariableName(key, PublicEnvPrefixes.mobile)], key).toBe(
        example[publicEnvVariableName(key, PublicEnvPrefixes.web)],
      )
    }
  })

  it('fills required variables and leaves optional ones empty or at their default', () => {
    const check = (
      name: string,
      value: string | undefined,
      doc: (typeof description.public)[number],
    ) => {
      expect(value, name).toBeDefined()
      if (doc.required) expect(value, `${name} is required`).not.toBe('')
      if (doc.defaultValue !== undefined && value !== '') {
        expect(value, `${name} placeholder must match the schema default`).toBe(doc.defaultValue)
      }
    }
    for (const doc of description.public) {
      for (const prefix of PUBLIC_ENV_PREFIXES) {
        const name = `${prefix}${doc.name}`
        check(name, example[name], doc)
      }
    }
    for (const doc of description.server) check(doc.name, example[doc.name], doc)
  })

  it.each(PUBLIC_ENV_PREFIXES)('loads cleanly through PublicEnvSchema under %s', (prefix) => {
    const env = loadPublicEnv(example, prefix)
    expect(env.APP_ENV).toBe(AppEnvs.development)
    expect(env.POSTHOG_KEY).toBeUndefined()
    expect(env.SENTRY_DSN).toBeUndefined()
    expect(env.SUPABASE_URL).toBe(example[`${prefix}SUPABASE_URL`])
  })

  it('loads cleanly through ServerEnvSchema with the mock provider', () => {
    const env = loadServerEnv(example)
    expect(env.APP_ENV).toBe(AppEnvs.development)
    expect(env.HUMAN_VERIFICATION_PROVIDER).toBe(HumanVerificationProviders.mock)
    expect(env.ROOM_GRACE_SECONDS).toBe(DEFAULT_ROOM_GRACE_SECONDS)
    expect(env.EXPO_ACCESS_TOKEN).toBeUndefined()
    expect(env.HUMAN_VERIFICATION_VENDOR_URL).toBeUndefined()
  })

  it('cannot be promoted to production by flipping APP_ENV alone', () => {
    const promoted = {
      ...example,
      APP_ENV: AppEnvs.production,
      ...Object.fromEntries(PUBLIC_APP_ENV_VARIABLES.map((name) => [name, AppEnvs.production])),
    }

    // Server: the mock provider is refused (ARCHITECTURE §14).
    const server = catchEnvError(() => loadServerEnv(promoted))
    expect(server.issues.map((issue) => issue.variable)).toEqual(['HUMAN_VERIFICATION_PROVIDER'])

    // Server, with only the public copies flipped: same refusal.
    const viaPublic = catchEnvError(() => loadServerEnv({ ...promoted, APP_ENV: '' }))
    expect(viaPublic.issues.map((issue) => issue.variable)).toEqual(['HUMAN_VERIFICATION_PROVIDER'])

    // Server, with only APP_ENV flipped: the disagreement with the public copies is refused too.
    const halfFlipped = catchEnvError(() =>
      loadServerEnv({ ...example, APP_ENV: AppEnvs.production }),
    )
    expect(halfFlipped.issues.map((issue) => issue.variable)).toEqual([
      'HUMAN_VERIFICATION_PROVIDER',
      'APP_ENV',
      'APP_ENV',
    ])

    // Clients: the localhost placeholders are refused outside development.
    for (const prefix of PUBLIC_ENV_PREFIXES) {
      const client = catchEnvError(() => loadPublicEnv(promoted, prefix))
      expect(client.issues.map((issue) => issue.variable)).toEqual(
        PUBLIC_DEVELOPMENT_DEFAULT_KEYS.map((key) => publicEnvVariableName(key, prefix)),
      )
    }
  })

  it('never ships a real-looking secret', () => {
    for (const key of SERVER_SECRET_KEYS) {
      const value = example[key]
      expect(value, key).toBeDefined()
      // LiveKit's dev-mode credential pair is public by construction (`livekit-server --dev`).
      if (key === 'LIVEKIT_API_SECRET') continue
      expect(value, key).toMatch(/^(replace-with-)?[a-z0-9-]*$/)
      if (value !== '') expect(value, key).toMatch(/^replace-with-/)
    }
    expect(example['NEXT_PUBLIC_SUPABASE_ANON_KEY']).toMatch(/^replace-with-/)
    expect(example['EXPO_PUBLIC_SUPABASE_ANON_KEY']).toMatch(/^replace-with-/)
  })
})
