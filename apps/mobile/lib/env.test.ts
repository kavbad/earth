import { describe, expect, it } from 'vitest'

import {
  MOBILE_PUBLIC_ENV_VARIABLES,
  expoPublicEnvSource,
  loadMobilePublicEnv,
  validatePublicEnv,
} from './env'

const VALID = {
  EXPO_PUBLIC_SUPABASE_URL: 'https://db.example.test',
  EXPO_PUBLIC_SUPABASE_ANON_KEY: 'anon',
  EXPO_PUBLIC_MAP_STYLE_URL: 'https://tiles.example.test/style.json',
}

describe('expoPublicEnvSource', () => {
  it('references exactly the public variables the schema knows', () => {
    expect(Object.keys(expoPublicEnvSource()).sort()).toEqual(
      [...MOBILE_PUBLIC_ENV_VARIABLES].sort(),
    )
  })
})

describe('loadMobilePublicEnv', () => {
  it('validates with the EXPO_PUBLIC_ prefix and applies development defaults', () => {
    const env = loadMobilePublicEnv(VALID)
    expect(env.SUPABASE_URL).toBe('https://db.example.test')
    expect(env.APP_ENV).toBe('development')
    expect(env.API_BASE_URL).toMatch(/^http:\/\/localhost/)
  })

  it('reports every problem as a value, never a throw from the shell', () => {
    const result = validatePublicEnv({ EXPO_PUBLIC_SUPABASE_URL: 'not a url' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.some((issue) => issue.startsWith('EXPO_PUBLIC_SUPABASE_URL'))).toBe(true)
    expect(result.issues.some((issue) => issue.startsWith('EXPO_PUBLIC_SUPABASE_ANON_KEY'))).toBe(
      true,
    )
  })
})
