import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'

import {
  REALTIME_SUBSCRIBE_STATUSES,
  type RealtimeChannelLike,
  type RealtimeClientLike,
  type RealtimeSubscriptionStatus,
  conversationChangesTopic,
  createChannelSupervisor,
  isRealtimeSubscribeStatus,
  postgresEqFilter,
  roomChangesTopic,
} from './channel'
import { createFakeClock } from './testing/fake-clock'
import { createFakeSupabase } from './testing/fake-supabase'

/** Compile-time check: the real supabase-js client satisfies the structural interface. */
const _supabaseIsRealtimeClientLike: (client: SupabaseClient) => RealtimeClientLike = (client) =>
  client

function setup(joinTimeoutMs = 5_000) {
  const supabase = createFakeSupabase()
  const clock = createFakeClock()
  const bind = vi.fn((_channel: RealtimeChannelLike) => undefined)
  const onSubscribed = vi.fn()
  const onFailure = vi.fn()
  const statuses: RealtimeSubscriptionStatus[] = []
  const supervisor = createChannelSupervisor({
    supabase,
    topic: 'test:topic',
    bind,
    clock,
    joinTimeoutMs,
    onSubscribed,
    onFailure,
    onStatus: (status) => statuses.push(status),
  })
  return { supabase, clock, bind, onSubscribed, onFailure, statuses, supervisor }
}

describe('helpers', () => {
  it('builds filters and topics', () => {
    expect(postgresEqFilter('conversation_id', 'abc')).toBe('conversation_id=eq.abc')
    expect(conversationChangesTopic('abc')).toBe('conversation:abc:changes')
    expect(roomChangesTopic('xyz')).toBe('room:xyz:changes')
  })

  it('recognises subscribe statuses', () => {
    for (const status of REALTIME_SUBSCRIBE_STATUSES) {
      expect(isRealtimeSubscribeStatus(status)).toBe(true)
    }
    expect(isRealtimeSubscribeStatus('JOINING')).toBe(false)
    expect(isRealtimeSubscribeStatus(undefined)).toBe(false)
  })
})

describe('createChannelSupervisor', () => {
  it('binds, subscribes and reports realtime mode on SUBSCRIBED', () => {
    const { supabase, bind, onSubscribed, supervisor, statuses } = setup()
    expect(supervisor.channel()).toBeNull()
    supervisor.start()
    supervisor.start()
    expect(supabase.channels).toHaveLength(1)
    const channel = supabase.latest()
    expect(bind).toHaveBeenCalledWith(channel)
    expect(channel.subscribeCalls).toBe(1)
    expect(supervisor.status()).toEqual({
      mode: 'realtime',
      subscribed: false,
      failures: 0,
      lastFailure: null,
    })

    channel.emitStatus('SUBSCRIBED')
    expect(onSubscribed).toHaveBeenCalledWith(channel, false)
    expect(supervisor.status().subscribed).toBe(true)
    expect(statuses.at(-1)?.mode).toBe('realtime')
  })

  it('degrades on join timeout, re-subscribes with backoff and recovers', () => {
    const { supabase, clock, onSubscribed, onFailure, supervisor } = setup(5_000)
    supervisor.start()
    const first = supabase.latest()
    clock.advance(4_999)
    expect(supervisor.mode()).toBe('realtime')
    clock.advance(1)
    expect(supervisor.mode()).toBe('polling')
    expect(first.removed).toBe(true)
    expect(onFailure).toHaveBeenCalledWith('join_timeout', 1, true, undefined)
    expect(supervisor.status()).toMatchObject({ failures: 1, lastFailure: 'join_timeout' })

    // First retry after 1 s.
    expect(clock.nextDelay()).toBe(1_000)
    clock.advance(1_000)
    expect(supabase.channels).toHaveLength(2)
    const second = supabase.latest()
    expect(second.subscribeCalls).toBe(1)

    // A late status from the removed channel is ignored.
    first.emitStatus('SUBSCRIBED')
    expect(supervisor.mode()).toBe('polling')

    second.emitStatus('SUBSCRIBED')
    expect(supervisor.mode()).toBe('realtime')
    expect(onSubscribed).toHaveBeenLastCalledWith(second, true)
    expect(supervisor.status()).toMatchObject({ failures: 0, lastFailure: null, subscribed: true })
    expect(clock.pending()).toBe(0)
  })

  it('backs off exponentially across repeated channel errors and degrades only once', () => {
    const { supabase, clock, onFailure, supervisor } = setup()
    supervisor.start()
    const error = new Error('replication down')
    supabase.latest().emitStatus('CHANNEL_ERROR', error)
    expect(onFailure).toHaveBeenLastCalledWith('CHANNEL_ERROR', 1, true, error)
    expect(clock.nextDelay()).toBe(1_000)
    clock.advance(1_000)
    supabase.latest().emitStatus('TIMED_OUT')
    expect(onFailure).toHaveBeenLastCalledWith('TIMED_OUT', 2, false, undefined)
    expect(clock.nextDelay()).toBe(2_000)
    clock.advance(2_000)
    supabase.latest().emitStatus('CLOSED')
    expect(onFailure).toHaveBeenLastCalledWith('CLOSED', 3, false, undefined)
    expect(clock.nextDelay()).toBe(4_000)
    expect(supabase.channels).toHaveLength(3)
    expect(supabase.active()).toHaveLength(0)
  })

  it('degrades to polling when a joined channel fails later', () => {
    const { supabase, clock, onFailure, supervisor } = setup()
    supervisor.start()
    supabase.latest().emitStatus('SUBSCRIBED')
    expect(clock.pending()).toBe(0)
    supabase.latest().emitStatus('CHANNEL_ERROR')
    expect(supervisor.mode()).toBe('polling')
    expect(supervisor.status()).toMatchObject({ subscribed: false, failures: 1 })
    expect(onFailure).toHaveBeenCalledWith('CHANNEL_ERROR', 1, true, undefined)
    expect(supabase.active()).toHaveLength(0)
    expect(clock.nextDelay()).toBe(1_000)
  })

  it('survives a status callback that fires synchronously inside subscribe()', () => {
    const supabase = createFakeSupabase()
    const clock = createFakeClock()
    const createChannel = supabase.channel.bind(supabase)
    supabase.channel = (topic, options) => {
      createChannel(topic, options)
      const channel = supabase.latest()
      const subscribe = channel.subscribe.bind(channel)
      channel.subscribe = (callback) => {
        subscribe(callback)
        channel.emitStatus('CHANNEL_ERROR', new Error('socket closed'))
        return channel
      }
      return channel
    }
    const onFailure = vi.fn()
    const supervisor = createChannelSupervisor({
      supabase,
      topic: 'test:topic',
      bind: () => undefined,
      clock,
      joinTimeoutMs: 5_000,
      onFailure,
    })
    expect(() => supervisor.start()).not.toThrow()
    expect(supervisor.mode()).toBe('polling')
    expect(supervisor.channel()).toBeNull()
    expect(supabase.active()).toHaveLength(0)
    expect(clock.pending()).toBe(1)
    expect(clock.nextDelay()).toBe(1_000)
    clock.advance(1_000)
    expect(onFailure).toHaveBeenCalledTimes(2)
    expect(clock.nextDelay()).toBe(2_000)
    supervisor.stop()
    expect(clock.pending()).toBe(0)
  })

  it('stop cancels timers, removes the channel and ignores later events', () => {
    const { supabase, clock, onFailure, supervisor } = setup()
    supervisor.start()
    const channel = supabase.latest()
    supervisor.stop()
    supervisor.stop()
    expect(channel.removed).toBe(true)
    expect(clock.pending()).toBe(0)
    channel.emitStatus('CHANNEL_ERROR')
    clock.advance(10_000)
    expect(onFailure).not.toHaveBeenCalled()
    expect(supabase.channels).toHaveLength(1)
    supervisor.start()
    expect(supabase.channels).toHaveLength(1)
  })
})
