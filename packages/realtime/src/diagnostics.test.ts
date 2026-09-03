import { describe, expect, it, vi } from 'vitest'

import { type RealtimeDiagnostics, emitDiagnostic, noopDiagnostics } from './diagnostics'

describe('emitDiagnostic', () => {
  it('never lets the emitter break the caller', async () => {
    const throwing: RealtimeDiagnostics = {
      emit: () => {
        throw new Error('sink down')
      },
    }
    const rejecting: RealtimeDiagnostics = { emit: () => Promise.reject(new Error('sink down')) }
    expect(() => emitDiagnostic(throwing, { kind: 'connected' })).not.toThrow()
    expect(() => emitDiagnostic(rejecting, { kind: 'connected' })).not.toThrow()
    expect(() => emitDiagnostic(noopDiagnostics, { kind: 'connected' })).not.toThrow()
    await Promise.resolve()
  })

  it('forwards the event', () => {
    const emit = vi.fn()
    emitDiagnostic({ emit }, { kind: 'realtime_fallback', channel: 'room' })
    expect(emit).toHaveBeenCalledWith({ kind: 'realtime_fallback', channel: 'room' })
  })
})
