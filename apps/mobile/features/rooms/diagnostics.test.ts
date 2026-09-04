import { RTC_DIAGNOSTIC_ENVELOPE_VERSION } from '@earth/api'
import { describe, expect, it, vi } from 'vitest'

import { createRtcDiagnostics } from './diagnostics'

describe('createRtcDiagnostics', () => {
  it('posts the envelope through the client and logs in development', () => {
    const rtc = vi.fn(() => Promise.resolve())
    const log = vi.fn()
    const diagnostics = createRtcDiagnostics({
      earth: { diagnostics: { rtc } } as never,
      isDevelopment: true,
      now: () => new Date('2026-09-03T00:00:00.000Z'),
      log,
    })
    diagnostics.emit({ kind: 'connect_attempt', attempt: 1 })
    expect(rtc).toHaveBeenCalledWith({
      v: RTC_DIAGNOSTIC_ENVELOPE_VERSION,
      ts: '2026-09-03T00:00:00.000Z',
      event: { kind: 'connect_attempt', attempt: 1 },
    })
    expect(log).toHaveBeenCalledOnce()
  })

  it('swallows a failed post and stays quiet in production', async () => {
    const rtc = vi.fn(() => Promise.reject(new Error('offline')))
    const log = vi.fn()
    const diagnostics = createRtcDiagnostics({
      earth: { diagnostics: { rtc } } as never,
      isDevelopment: false,
      log,
    })
    expect(() => diagnostics.emit({ kind: 'connect_attempt', attempt: 2 })).not.toThrow()
    await Promise.resolve()
    expect(log).not.toHaveBeenCalled()
  })
})
