import { EnvError } from '@earth/config'
import { describe, expect, it } from 'vitest'

import {
  WEB_PUBLIC_ENV_PREFIX,
  WEB_PUBLIC_ENV_VARIABLES,
  loadWebPublicEnv,
  nextPublicEnvSource,
} from './public-env'

describe('nextPublicEnvSource', () => {
  it('references exactly the NEXT_PUBLIC_* variables the schema defines', () => {
    expect(WEB_PUBLIC_ENV_PREFIX).toBe('NEXT_PUBLIC_')
    expect(Object.keys(nextPublicEnvSource()).sort()).toEqual([...WEB_PUBLIC_ENV_VARIABLES].sort())
  })
})

describe('loadWebPublicEnv', () => {
  it('validates a source under the NEXT_PUBLIC_ prefix', () => {
    const env = loadWebPublicEnv({
      NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321/',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon',
      NEXT_PUBLIC_MAP_STYLE_URL: 'https://demotiles.maplibre.org/style.json',
    })
    expect(env.SUPABASE_URL).toBe('http://localhost:54321')
    expect(env.SUPABASE_ANON_KEY).toBe('anon')
    expect(env.APP_ENV).toBe('development')
  })

  it('reports missing variables with their prefixed names', () => {
    let caught: unknown
    try {
      loadWebPublicEnv({ NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' })
    } catch (cause) {
      caught = cause
    }
    expect(caught).toBeInstanceOf(EnvError)
    expect((caught as EnvError).issues.map((issue) => issue.variable)).toContain(
      'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    )
  })
})
