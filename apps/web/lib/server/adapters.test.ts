import { createClient } from '@supabase/supabase-js'
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk'
import { describe, expect, it } from 'vitest'

import {
  type ExpoSdkLike,
  type SentryNamespaceLike,
  expoClientFrom,
  sentrySdkFrom,
  supabaseClientFrom,
  withoutUndefined,
} from './adapters'
import { IDENTITY_REVIEWS_TABLE } from './verification'

describe('supabaseClientFrom', () => {
  it('exposes rpc and the identity_reviews chain lazily (no request until awaited)', () => {
    const client = supabaseClientFrom(createClient('http://localhost:54321', 'anon-key'))
    const rpc = client.rpc('rooms_sweep', {})
    expect(typeof rpc.then).toBe('function')
    const insert = client
      .from(IDENTITY_REVIEWS_TABLE)
      .insert({ human_id: 'h', kind: 'help', status: 'open', details: {} })
      .select('id')
    expect(typeof insert.single).toBe('function')
    const read = client.from(IDENTITY_REVIEWS_TABLE).select('status').eq('id', 'review-1')
    expect(typeof read.maybeSingle).toBe('function')
  })
})

describe('expoClientFrom', () => {
  function fakeExpo(tickets: ExpoPushTicket[], receipts: Record<string, ExpoPushReceipt>) {
    const sent: ExpoPushMessage[][] = []
    const sdk: ExpoSdkLike = {
      chunkPushNotifications: (messages) => [messages.slice(0, 2), messages.slice(2)],
      sendPushNotificationsAsync: async (messages) => {
        sent.push(messages)
        return tickets
      },
      getPushNotificationReceiptsAsync: async () => receipts,
      chunkPushNotificationReceiptIds: (ids) => [ids],
    }
    return { sdk, sent }
  }

  it('delegates chunking and sending and narrows tickets and receipts', async () => {
    const { sdk, sent } = fakeExpo(
      [
        { status: 'ok', id: 'r1' },
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', message: 'bad' },
      ],
      { r1: { status: 'ok', details: { extra: true } }, r2: { status: 'error', message: 'late' } },
    )
    const client = expoClientFrom(sdk)
    const messages = [{ to: 'ExponentPushToken[a]' }, { to: 'ExponentPushToken[b]' }, { to: 'ExponentPushToken[c]' }]
    expect(client.chunkPushNotifications(messages)).toEqual([messages.slice(0, 2), messages.slice(2)])
    await expect(client.sendPushNotificationsAsync(messages)).resolves.toEqual([
      { status: 'ok', id: 'r1' },
      { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      { status: 'error', message: 'bad' },
    ])
    expect(sent).toEqual([messages])
    await expect(client.getPushNotificationReceiptsAsync?.(['r1', 'r2'])).resolves.toEqual({
      r1: { status: 'ok' },
      r2: { status: 'error', message: 'late' },
    })
    expect(client.chunkPushNotificationReceiptIds?.(['r1'])).toEqual([['r1']])
  })
})

describe('withoutUndefined', () => {
  it('drops undefined members and keeps everything else', () => {
    expect(withoutUndefined({ a: 1, b: undefined, c: null, d: 'x' })).toEqual({ a: 1, c: null, d: 'x' })
  })
})

describe('sentrySdkFrom', () => {
  function fakeNamespace() {
    const calls: { readonly method: string; readonly args: unknown[] }[] = []
    const record =
      (method: string) =>
      (...args: unknown[]) => {
        calls.push({ method, args })
        return undefined
      }
    const sentry: SentryNamespaceLike = {
      init: record('init'),
      captureException: record('captureException'),
      captureMessage: record('captureMessage'),
      setUser: record('setUser'),
      addBreadcrumb: record('addBreadcrumb'),
      setTag: record('setTag'),
      flush: async (timeout) => {
        calls.push({ method: 'flush', args: [timeout] })
        return true
      },
    }
    return { sentry, calls }
  }

  it('forwards every call with undefined members removed', async () => {
    const { sentry, calls } = fakeNamespace()
    const sdk = sentrySdkFrom(sentry)
    const error = new Error('boom')
    sdk.init({ dsn: 'https://k@s.example/1', environment: 'preview', release: 'r', sendDefaultPii: false })
    sdk.captureException(error)
    sdk.captureException(error, { level: 'error', tags: undefined, extra: { a: 1 }, fingerprint: undefined })
    sdk.captureMessage('m')
    sdk.captureMessage('m', 'warning')
    sdk.captureMessage('m', { level: 'info', extra: undefined })
    sdk.setUser(null)
    sdk.setUser({ id: 'h1', username: undefined })
    sdk.addBreadcrumb({ category: 'rtc', message: undefined, timestamp: 1 })
    sdk.setTag?.('k', 'v')
    await expect(sdk.flush?.(500)).resolves.toBe(true)
    expect(calls).toEqual([
      { method: 'init', args: [{ dsn: 'https://k@s.example/1', environment: 'preview', release: 'r', sendDefaultPii: false }] },
      { method: 'captureException', args: [error] },
      { method: 'captureException', args: [error, { level: 'error', extra: { a: 1 } }] },
      { method: 'captureMessage', args: ['m'] },
      { method: 'captureMessage', args: ['m', 'warning'] },
      { method: 'captureMessage', args: ['m', { level: 'info' }] },
      { method: 'setUser', args: [null] },
      { method: 'setUser', args: [{ id: 'h1' }] },
      { method: 'addBreadcrumb', args: [{ category: 'rtc', timestamp: 1 }] },
      { method: 'setTag', args: ['k', 'v'] },
      { method: 'flush', args: [500] },
    ])
  })
})
