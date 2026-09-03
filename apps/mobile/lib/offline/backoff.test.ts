import { describe, expect, it } from 'vitest'

import {
  INITIAL_ONLINE_STATE,
  OFFLINE_PROBE_MAX_MS,
  type OnlineState,
  onlineReducer,
  probeDelayMs,
} from './state'

function offline(failures: number): OnlineState {
  return { online: false, checking: false, failures }
}

describe('probe backoff', () => {
  it('probes at once while a suspicion is being confirmed', () => {
    expect(probeDelayMs(onlineReducer(INITIAL_ONLINE_STATE, { type: 'suspect' }))).toBe(0)
    expect(probeDelayMs(onlineReducer(offline(3), { type: 'foreground' }))).toBe(0)
  })

  it('doubles from 3 s while offline and caps at 30 s', () => {
    expect(probeDelayMs(offline(1))).toBe(3_000)
    expect(probeDelayMs(offline(2))).toBe(6_000)
    expect(probeDelayMs(offline(3))).toBe(12_000)
    expect(probeDelayMs(offline(4))).toBe(24_000)
    expect(probeDelayMs(offline(5))).toBe(OFFLINE_PROBE_MAX_MS)
    expect(probeDelayMs(offline(50))).toBe(OFFLINE_PROBE_MAX_MS)
  })

  it('starts over after a probe succeeds', () => {
    const back = onlineReducer(offline(4), { type: 'probe_ok' })
    expect(back).toEqual(INITIAL_ONLINE_STATE)
    expect(probeDelayMs(onlineReducer(back, { type: 'suspect' }))).toBe(0)
  })
})
