import { REALTIME_JOIN_TIMEOUT_MS, asConversationId, asRoomId } from '@earth/domain'
import { describe, expect, it, vi } from 'vitest'

import {
  EMPTY_PRESENCE_CONTEXT,
  PRESENCE_JOIN_TIMEOUT_MS,
  PRESENCE_PING_INTERVAL_MS,
  type PresencePeer,
  TYPING_TTL_MS,
  createPresencePinger,
  joinPresence,
  parsePresenceState,
  presenceTopic,
} from './presence'
import { createFakeClock, flushPromises } from './testing/fake-clock'
import { createFakeSupabase } from './testing/fake-supabase'
import { createRecordingDiagnostics } from './testing/fakes'

const CONVERSATION_ID = asConversationId('11111111-1111-4111-8111-111111111111')
const ROOM_ID = asRoomId('55555555-5555-4555-8555-555555555555')
const ME = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PEER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function setup() {
  const supabase = createFakeSupabase()
  const clock = createFakeClock(Date.parse('2026-09-03T12:00:00.000Z'))
  const diagnostics = createRecordingDiagnostics()
  const peerUpdates: Array<readonly PresencePeer[]> = []
  const handle = joinPresence({
    supabase,
    kind: 'conversation',
    id: CONVERSATION_ID,
    key: ME,
    onPeers: (peers) => peerUpdates.push(peers),
    diagnostics,
    clock,
  })
  return { supabase, clock, diagnostics, peerUpdates, handle }
}

describe('presenceTopic', () => {
  it('matches ARCHITECTURE §8 channel names', () => {
    expect(presenceTopic('conversation', 'abc')).toBe('conversation:abc')
    expect(presenceTopic('room', 'xyz')).toBe('room:xyz')
  })
})

describe('PRESENCE_JOIN_TIMEOUT_MS', () => {
  it('is the shared realtime join timeout', () => {
    expect(PRESENCE_JOIN_TIMEOUT_MS).toBe(REALTIME_JOIN_TIMEOUT_MS)
  })
})

describe('parsePresenceState', () => {
  it('reads the newest entry per key and expires stale typing', () => {
    const now = Date.parse('2026-09-03T12:00:10.000Z')
    const peers = parsePresenceState(
      {
        [ME]: [
          { presence_ref: '1', typing: true, active: true, updatedAt: '2026-09-03T12:00:09.000Z' },
        ],
        [PEER]: [
          { presence_ref: '2', typing: true, active: false, updatedAt: '2026-09-03T12:00:00.000Z' },
          { presence_ref: '3', typing: false, active: true, updatedAt: '2026-09-03T12:00:08.000Z' },
        ],
        ghost: [{ presence_ref: '4' }],
      },
      ME,
      now,
    )
    expect(peers).toEqual([
      { key: ME, typing: true, active: true, updatedAt: '2026-09-03T12:00:09.000Z', isSelf: true },
      {
        key: PEER,
        typing: false,
        active: true,
        updatedAt: '2026-09-03T12:00:08.000Z',
        isSelf: false,
      },
      { key: 'ghost', typing: false, active: false, updatedAt: null, isSelf: false },
    ])
  })
})

describe('joinPresence', () => {
  it('joins with the presence key and tracks once subscribed', async () => {
    const { supabase, handle } = setup()
    const channel = supabase.latest()
    expect(channel.topic).toBe(`conversation:${CONVERSATION_ID}`)
    expect(channel.options).toEqual({ config: { presence: { key: ME, enabled: true } } })
    expect(channel.presenceSyncListeners).toHaveLength(1)

    await handle.trackActive()
    expect(channel.tracked).toEqual([])
    expect(handle.subscribed()).toBe(false)

    channel.emitStatus('SUBSCRIBED')
    await flushPromises()
    expect(handle.subscribed()).toBe(true)
    expect(channel.tracked).toEqual([
      { typing: false, active: true, updatedAt: '2026-09-03T12:00:00.000Z' },
    ])
  })

  it('auto-clears typing after the TTL', async () => {
    const { supabase, clock, handle } = setup()
    const channel = supabase.latest()
    channel.emitStatus('SUBSCRIBED')
    await handle.trackTyping()
    expect(channel.tracked.at(-1)).toMatchObject({ typing: true, active: true })
    await clock.advanceAsync(TYPING_TTL_MS - 1)
    expect(channel.tracked).toHaveLength(1)
    await clock.advanceAsync(1)
    expect(channel.tracked.at(-1)).toMatchObject({ typing: false, active: true })
    expect(channel.tracked).toHaveLength(2)

    await handle.trackTyping(true)
    await handle.trackTyping(false)
    expect(clock.pending()).toBe(0)
    expect(channel.tracked.at(-1)).toMatchObject({ typing: false })
  })

  it('publishes peers on sync and filters typing peers', async () => {
    const { supabase, clock, peerUpdates, handle } = setup()
    const channel = supabase.latest()
    channel.emitStatus('SUBSCRIBED')
    const at = new Date(clock.now()).toISOString()
    channel.setPresenceState({
      [ME]: [{ presence_ref: '1', typing: true, active: true, updatedAt: at }],
      [PEER]: [{ presence_ref: '2', typing: true, active: true, updatedAt: at }],
    })
    channel.emitPresenceSync()
    expect(peerUpdates).toHaveLength(1)
    expect(handle.peers().map((p) => p.key)).toEqual([ME, PEER])
    expect(handle.typingPeers().map((p) => p.key)).toEqual([PEER])
  })

  it('survives track errors, reports fallback and recovery, and re-tracks after re-join', async () => {
    const { supabase, clock, diagnostics, handle } = setup()
    supabase.trackError = new Error('not joined')
    supabase.latest().emitStatus('SUBSCRIBED')
    await expect(handle.trackActive()).resolves.toBeUndefined()
    supabase.trackError = null

    supabase.latest().emitStatus('CHANNEL_ERROR')
    expect(diagnostics.events[0]).toMatchObject({ kind: 'realtime_fallback', channel: 'presence' })
    await clock.advanceAsync(1_000)
    const second = supabase.latest()
    expect(second).not.toBe(supabase.channels[0])
    second.emitStatus('SUBSCRIBED')
    await flushPromises()
    expect(diagnostics.kinds()).toEqual(['realtime_fallback', 'realtime_recovered'])
    expect(second.tracked).toEqual([
      { typing: false, active: true, updatedAt: '2026-09-03T12:00:00.000Z' },
    ])
  })

  it('leave untracks, removes the channel and is idempotent', async () => {
    const { supabase, clock, handle } = setup()
    const channel = supabase.latest()
    channel.emitStatus('SUBSCRIBED')
    await handle.trackTyping()
    await handle.leave()
    await handle.leave()
    expect(channel.untrackCalls).toBe(1)
    expect(channel.removed).toBe(true)
    expect(clock.pending()).toBe(0)
    await handle.trackActive()
    expect(channel.tracked).toHaveLength(1)
  })
})

describe('createPresencePinger', () => {
  function setupPinger(foregrounded = true) {
    const clock = createFakeClock()
    const presencePing = vi.fn(async () => undefined)
    const foreground = { value: foregrounded }
    const onError = vi.fn()
    const pinger = createPresencePinger({
      presencePing,
      foregrounded: () => foreground.value,
      clock,
      onError,
    })
    return { clock, presencePing, foreground, onError, pinger }
  }

  it('pings on start and every 30 s while foregrounded', async () => {
    const { clock, presencePing, foreground, pinger } = setupPinger()
    expect(PRESENCE_PING_INTERVAL_MS).toBe(30_000)
    expect(pinger.context()).toEqual(EMPTY_PRESENCE_CONTEXT)
    pinger.start()
    pinger.start()
    await flushPromises()
    expect(presencePing).toHaveBeenCalledTimes(1)
    expect(presencePing).toHaveBeenLastCalledWith(null, null)
    await clock.advanceAsync(29_999)
    expect(presencePing).toHaveBeenCalledTimes(1)
    await clock.advanceAsync(1)
    expect(presencePing).toHaveBeenCalledTimes(2)
    await clock.advanceAsync(60_000)
    expect(presencePing).toHaveBeenCalledTimes(4)

    foreground.value = false
    await clock.advanceAsync(60_000)
    expect(presencePing).toHaveBeenCalledTimes(4)
    foreground.value = true
    await clock.advanceAsync(30_000)
    expect(presencePing).toHaveBeenCalledTimes(5)

    pinger.stop()
    expect(pinger.running()).toBe(false)
    await clock.advanceAsync(90_000)
    expect(presencePing).toHaveBeenCalledTimes(5)
  })

  it('pings immediately when the context changes and passes it through', async () => {
    const { clock, presencePing, pinger } = setupPinger()
    pinger.setContext({ conversationId: CONVERSATION_ID, roomId: null })
    await flushPromises()
    expect(presencePing).not.toHaveBeenCalled()
    pinger.start()
    await flushPromises()
    expect(presencePing).toHaveBeenLastCalledWith(CONVERSATION_ID, null)
    pinger.setContext({ conversationId: CONVERSATION_ID, roomId: null })
    await flushPromises()
    expect(presencePing).toHaveBeenCalledTimes(1)
    pinger.setContext({ conversationId: null, roomId: ROOM_ID })
    await flushPromises()
    expect(presencePing).toHaveBeenCalledTimes(2)
    expect(presencePing).toHaveBeenLastCalledWith(null, ROOM_ID)
    await clock.advanceAsync(30_000)
    expect(presencePing).toHaveBeenLastCalledWith(null, ROOM_ID)
  })

  it('skips the start ping in the background but pingNow always pings; errors go to onError', async () => {
    const { presencePing, onError, pinger } = setupPinger(false)
    pinger.start()
    await flushPromises()
    expect(presencePing).not.toHaveBeenCalled()
    presencePing.mockRejectedValueOnce(new Error('offline'))
    await pinger.pingNow()
    expect(presencePing).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })
})
