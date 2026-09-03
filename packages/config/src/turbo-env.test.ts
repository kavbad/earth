/**
 * Keeps the root `turbo.json` in lockstep with the schemas: every server variable is part of the
 * build hash (otherwise a changed secret or provider could be served from a stale cached build)
 * and both public prefixes are hashed as wildcards.
 */
import { describe, expect, it } from 'vitest'

import { PUBLIC_ENV_PREFIXES, SERVER_ENV_KEYS } from './env'
import { readRepoFile, TOOLING_ENV_KEYS } from './testing'

interface TurboConfig {
  readonly globalEnv?: readonly string[]
  readonly globalPassThroughEnv?: readonly string[]
  readonly tasks?: Readonly<Record<string, { readonly env?: readonly string[] }>>
}

const turbo = JSON.parse(readRepoFile('turbo.json')) as TurboConfig
const globalEnv = turbo.globalEnv ?? []
const buildEnv = turbo.tasks?.['build']?.env ?? []
const hashed = new Set<string>([...globalEnv, ...buildEnv])

describe('turbo.json', () => {
  it('hashes every server variable into the build', () => {
    for (const key of SERVER_ENV_KEYS) expect(hashed.has(key), key).toBe(true)
  })

  it('hashes every public prefix as a wildcard', () => {
    for (const prefix of PUBLIC_ENV_PREFIXES) expect(buildEnv).toContain(`${prefix}*`)
  })

  it('lists no stale server variables', () => {
    const known = new Set<string>([...SERVER_ENV_KEYS])
    const literal = buildEnv.filter((entry) => !entry.endsWith('*'))
    for (const entry of literal) expect(known.has(entry), entry).toBe(true)
  })

  it('passes the tooling variables through', () => {
    for (const key of TOOLING_ENV_KEYS) expect(turbo.globalPassThroughEnv).toContain(key)
  })
})
