import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { roomCopy } from '../copy'
import { MEDIA_STATUSES, connectionOverlay } from './connection'

describe('connectionOverlay (spec §107, §109)', () => {
  it('shows nothing while connected, before connecting, or after leaving', () => {
    for (const status of ['connected', 'idle', 'disconnected'] as const) {
      expect(connectionOverlay(status, true).kind).toBe('none')
      expect(connectionOverlay(status, false).kind).toBe('none')
    }
  })

  it('says "Connecting…" on the way in and "Reconnecting…" while retrying', () => {
    expect(connectionOverlay('connecting', true)).toEqual({
      kind: 'connecting',
      line: roomCopy.connecting,
      spinner: true,
      actions: false,
    })
    expect(connectionOverlay('reconnecting', true)).toEqual({
      kind: 'reconnecting',
      line: copy.reconnecting,
      spinner: true,
      actions: false,
    })
    expect(copy.reconnecting).toBe('Reconnecting…')
  })

  it('offers Try again / Leave once the policy is exhausted', () => {
    expect(connectionOverlay('failed', true)).toEqual({
      kind: 'failed',
      line: copy.couldntReconnect,
      spinner: false,
      actions: true,
    })
    expect(copy.couldntReconnect).toBe("Couldn't reconnect")
    expect(copy.tryAgain).toBe('Try again')
    expect(copy.leave).toBe('Leave')
  })

  it('names the missing network instead of a generic error', () => {
    expect(connectionOverlay('reconnecting', false)).toMatchObject({
      kind: 'offline',
      line: copy.connectionUnavailable,
      spinner: true,
      actions: false,
    })
    expect(connectionOverlay('failed', false)).toMatchObject({
      kind: 'offline',
      line: copy.connectionUnavailable,
      actions: true,
    })
  })

  it('covers every media status', () => {
    for (const status of MEDIA_STATUSES) {
      expect(() => connectionOverlay(status, true)).not.toThrow()
    }
  })
})
