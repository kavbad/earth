import { NETWORK_UNAVAILABLE_REASON } from '@earth/realtime'
import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { roomCopy } from '../copy'
import {
  CLIENT_INITIATED_CODE,
  connectionPresentation,
  isUnexpectedDisconnect,
  shouldRetryWhenOnline,
} from './connection'

describe('connectionPresentation (spec §107, §109)', () => {
  it('is quiet before connecting, while connected online, and after leaving', () => {
    expect(connectionPresentation({ status: 'idle', detail: {}, online: true })).toEqual({
      kind: 'hidden',
    })
    expect(connectionPresentation({ status: 'connected', detail: {}, online: true })).toEqual({
      kind: 'hidden',
    })
    expect(
      connectionPresentation({
        status: 'disconnected',
        detail: { code: CLIENT_INITIATED_CODE },
        online: true,
      }),
    ).toEqual({ kind: 'hidden' })
  })

  it('says "Reconnecting…" while the SDK or Earth retries, "Connecting…" at first', () => {
    expect(connectionPresentation({ status: 'connecting', detail: {}, online: true })).toEqual({
      kind: 'busy',
      line: roomCopy.connecting,
    })
    expect(
      connectionPresentation({ status: 'reconnecting', detail: { attempt: 2 }, online: true }),
    ).toEqual({ kind: 'busy', line: copy.reconnecting })
  })

  it('offers "Try again" / "Leave" once the policy is exhausted', () => {
    expect(connectionPresentation({ status: 'failed', detail: {}, online: true })).toEqual({
      kind: 'failed',
      line: copy.couldntReconnect,
    })
  })

  it('treats a drop nobody asked for as a lost connection, never a frozen stage', () => {
    expect(isUnexpectedDisconnect('disconnected', { code: 'DUPLICATE_IDENTITY' })).toBe(true)
    expect(isUnexpectedDisconnect('disconnected', {})).toBe(true)
    expect(isUnexpectedDisconnect('disconnected', { code: CLIENT_INITIATED_CODE })).toBe(false)
    expect(isUnexpectedDisconnect('connected', {})).toBe(false)
    expect(
      connectionPresentation({
        status: 'disconnected',
        detail: { code: 'DUPLICATE_IDENTITY' },
        online: true,
      }),
    ).toEqual({ kind: 'failed', line: copy.couldntReconnect })
  })

  it('says connection unavailable whenever the device is offline', () => {
    for (const status of ['connecting', 'reconnecting', 'connected'] as const) {
      expect(connectionPresentation({ status, detail: {}, online: false })).toEqual({
        kind: 'busy',
        line: copy.connectionUnavailable,
      })
    }
    expect(
      connectionPresentation({
        status: 'failed',
        detail: { code: NETWORK_UNAVAILABLE_REASON },
        online: false,
      }),
    ).toEqual({ kind: 'failed', line: copy.connectionUnavailable })
  })
})

describe('shouldRetryWhenOnline', () => {
  it('retries only a failure caused by the missing network', () => {
    expect(shouldRetryWhenOnline('failed', { code: NETWORK_UNAVAILABLE_REASON })).toBe(true)
    expect(shouldRetryWhenOnline('failed', { reason: 'token' })).toBe(false)
    expect(shouldRetryWhenOnline('disconnected', { code: NETWORK_UNAVAILABLE_REASON })).toBe(false)
    expect(shouldRetryWhenOnline('connected', {})).toBe(false)
  })
})
