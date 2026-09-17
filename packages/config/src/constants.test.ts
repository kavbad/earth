import { describe, expect, it } from 'vitest'

import { APP_NAME, LOCAL_HOST, LOCAL_PORTS, LOCAL_URLS, PRODUCTION_WEB_ORIGIN } from './constants'
import { readRepoFile, tomlValue } from './testing'

describe('constants', () => {
  it('names the product and its production origin', () => {
    expect(APP_NAME).toBe('Earth')
    expect(PRODUCTION_WEB_ORIGIN).toBe('https://earth.social')
    expect(new URL(PRODUCTION_WEB_ORIGIN).origin).toBe(PRODUCTION_WEB_ORIGIN)
  })

  it('pins the local stack ports (ARCHITECTURE §15)', () => {
    expect(LOCAL_PORTS).toEqual({
      web: 3000,
      gateway: 54321,
      postgrest: 3001,
      gotrue: 9999,
      livekit: 7880,
      mailpitSmtp: 1025,
      mailpitHttp: 8025,
    })
    expect(new Set(Object.values(LOCAL_PORTS)).size).toBe(Object.keys(LOCAL_PORTS).length)
  })

  it('uses the Supabase CLI API port for the gateway (supabase/config.toml [api].port)', () => {
    expect(LOCAL_PORTS.gateway).toBe(
      Number(tomlValue(readRepoFile('supabase/config.toml'), 'api', 'port')),
    )
  })

  it('derives local URLs from the ports', () => {
    expect(LOCAL_HOST).toBe('localhost')
    expect(LOCAL_URLS.web).toBe('http://localhost:3000')
    expect(LOCAL_URLS.supabase).toBe('http://localhost:54321')
    expect(LOCAL_URLS.postgrest).toBe('http://localhost:3001')
    expect(LOCAL_URLS.gotrue).toBe('http://localhost:9999')
    expect(LOCAL_URLS.livekit).toBe('ws://localhost:7880')
    expect(LOCAL_URLS.mailpitHttp).toBe('http://localhost:8025')
    for (const url of Object.values(LOCAL_URLS)) expect(new URL(url).origin).toBe(url)
  })
})
