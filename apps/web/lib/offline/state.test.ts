import { describe, expect, it } from 'vitest'

import { initialOnlineState, onlineReducer, shouldProbe } from './state'

describe('onlineReducer', () => {
  it('goes offline on the browser event without waiting for a probe', () => {
    const next = onlineReducer(initialOnlineState(true), { type: 'browser_offline' })
    expect(next.online).toBe(false)
    expect(shouldProbe(next)).toBe(true)
  })

  it('confirms a browser online event with a probe before clearing the banner', () => {
    const offline = onlineReducer(initialOnlineState(true), { type: 'browser_offline' })
    const checking = onlineReducer(offline, { type: 'browser_online' })
    expect(checking.online).toBe(false)
    expect(checking.checking).toBe(true)
    expect(onlineReducer(checking, { type: 'probe_ok' })).toEqual({
      online: true,
      checking: false,
      failures: 0,
    })
  })

  it('counts failed probes and keeps probing', () => {
    let state = initialOnlineState(false)
    state = onlineReducer(state, { type: 'probe_failed' })
    state = onlineReducer(state, { type: 'probe_failed' })
    expect(state.failures).toBe(2)
    expect(shouldProbe(state)).toBe(true)
  })

  it('does not probe while online and settled', () => {
    expect(shouldProbe(initialOnlineState(true))).toBe(false)
  })
})
