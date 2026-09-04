import { describe, expect, it } from 'vitest'

import * as config from './index'

describe('@earth/config', () => {
  it('exposes its package name', () => {
    expect(config.PACKAGE_NAME).toBe('@earth/config')
  })

  it('re-exports the env, flags and constants modules', () => {
    expect(typeof config.loadPublicEnv).toBe('function')
    expect(typeof config.loadServerEnv).toBe('function')
    expect(typeof config.describeEnv).toBe('function')
    expect(typeof config.resolveFlags).toBe('function')
    expect(config.FEATURE_FLAG_KEYS.length).toBe(11)
    expect(config.APP_NAME).toBe('Earth')
    expect(config.PRODUCTION_WEB_ORIGIN).toBe('https://earth.social')
  })
})
