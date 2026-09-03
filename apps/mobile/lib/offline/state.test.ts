import { describe, expect, it } from 'vitest'

import {
  INITIAL_ONLINE_STATE,
  healthProbeUrl,
  isNetworkError,
  onlineReducer,
  shouldProbe,
} from './state'

describe('onlineReducer', () => {
  it('assumes online and probes only on suspicion', () => {
    expect(shouldProbe(INITIAL_ONLINE_STATE)).toBe(false)
    const suspect = onlineReducer(INITIAL_ONLINE_STATE, { type: 'suspect' })
    expect(suspect.online).toBe(true)
    expect(shouldProbe(suspect)).toBe(true)
    expect(onlineReducer(suspect, { type: 'suspect' })).toBe(suspect)
  })

  it('goes offline on a failed probe and keeps probing until one succeeds', () => {
    const offline = onlineReducer(onlineReducer(INITIAL_ONLINE_STATE, { type: 'suspect' }), {
      type: 'probe_failed',
    })
    expect(offline).toEqual({ online: false, checking: false, failures: 1 })
    expect(shouldProbe(offline)).toBe(true)
    expect(onlineReducer(offline, { type: 'probe_failed' }).failures).toBe(2)
    expect(onlineReducer(offline, { type: 'probe_ok' })).toEqual(INITIAL_ONLINE_STATE)
  })

  it('re-checks on foreground only while offline', () => {
    expect(onlineReducer(INITIAL_ONLINE_STATE, { type: 'foreground' })).toBe(INITIAL_ONLINE_STATE)
    const offline = { online: false, checking: false, failures: 3 }
    expect(onlineReducer(offline, { type: 'foreground' }).checking).toBe(true)
  })
})

describe('probe helpers', () => {
  it('builds the health URL without doubling slashes', () => {
    expect(healthProbeUrl('https://earth.social/')).toBe('https://earth.social/api/health')
    expect(healthProbeUrl('http://localhost:3000')).toBe('http://localhost:3000/api/health')
  })

  it('recognises network failures and nothing else', () => {
    expect(isNetworkError(new TypeError('Network request failed'))).toBe(true)
    expect(isNetworkError({ name: 'AbortError', message: 'Aborted' })).toBe(true)
    expect(isNetworkError({ message: 'internal', details: { reason: 'network_error' } })).toBe(true)
    expect(isNetworkError(new Error('not_a_member'))).toBe(false)
    expect(isNetworkError(null)).toBe(false)
    expect(isNetworkError('nope')).toBe(false)
  })
})
