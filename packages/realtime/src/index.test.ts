import { describe, expect, it } from 'vitest'

import * as realtime from './index'
import * as testing from './testing/index'

describe('@earth/realtime', () => {
  it('exposes its package name and the public modules', () => {
    expect(realtime.PACKAGE_NAME).toBe('@earth/realtime')
    expect(typeof realtime.subscribeConversation).toBe('function')
    expect(typeof realtime.subscribeRoom).toBe('function')
    expect(typeof realtime.joinPresence).toBe('function')
    expect(typeof realtime.createPresencePinger).toBe('function')
    expect(typeof realtime.connectLiveKit).toBe('function')
    expect(typeof realtime.createOutbox).toBe('function')
    expect(typeof realtime.createChannelSupervisor).toBe('function')
    expect(realtime.systemClock.now()).toBeGreaterThan(0)
  })

  it('exposes test doubles from the testing entry point', () => {
    expect(typeof testing.createFakeClock).toBe('function')
    expect(typeof testing.createFakeSupabase).toBe('function')
    expect(typeof testing.createFakeRoom).toBe('function')
    expect(typeof testing.createRecordingDiagnostics).toBe('function')
    expect(typeof testing.createMemoryOutboxStorage).toBe('function')
  })
})
