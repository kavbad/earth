import { describe, expect, it } from 'vitest'

import type { PushMessage } from '../deps'
import {
  CHUNK_FAILED_MESSAGE,
  type ExpoClientLike,
  type ExpoPushMessageLike,
  INVALID_TOKEN_MESSAGE,
  createExpoPushSender,
  isExpoPushToken,
} from './expo'

function message(to: string): PushMessage {
  return {
    to,
    title: 't',
    body: 'b',
    data: { type: 'follow' },
    priority: 'high',
    sound: 'default',
    channelId: 'social',
  }
}

interface FakeExpo extends ExpoClientLike {
  readonly sent: ExpoPushMessageLike[][]
  failChunk: number | null
}

function fakeExpo(chunkSize: number): FakeExpo {
  const sent: ExpoPushMessageLike[][] = []
  const expo: FakeExpo = {
    sent,
    failChunk: null,
    chunkPushNotifications(messages) {
      const chunks: ExpoPushMessageLike[][] = []
      for (let i = 0; i < messages.length; i += chunkSize)
        chunks.push(messages.slice(i, i + chunkSize))
      return chunks
    },
    async sendPushNotificationsAsync(chunk) {
      if (expo.failChunk === sent.length) {
        sent.push(chunk)
        throw new Error('gateway timeout')
      }
      sent.push(chunk)
      return chunk.map((m, i) =>
        typeof m.to === 'string' && m.to.includes('dead')
          ? {
              status: 'error' as const,
              message: 'not registered',
              details: { error: 'DeviceNotRegistered', expoPushToken: m.to },
            }
          : { status: 'ok' as const, id: `${sent.length}-${i}` },
      )
    },
    async getPushNotificationReceiptsAsync(ids) {
      return Object.fromEntries(
        ids.map((id) => [
          id,
          id.endsWith('bad')
            ? { status: 'error' as const, message: 'x', details: { error: 'DeviceNotRegistered' } }
            : { status: 'ok' as const },
        ]),
      )
    },
  }
  return expo
}

describe('isExpoPushToken', () => {
  it('mirrors the Expo rule', () => {
    expect(isExpoPushToken('ExponentPushToken[abc]')).toBe(true)
    expect(isExpoPushToken('ExpoPushToken[abc]')).toBe(true)
    expect(isExpoPushToken('12345678-1234-1234-1234-123456789abc')).toBe(true)
    expect(isExpoPushToken('apns-raw-token')).toBe(false)
    expect(isExpoPushToken('ExponentPushToken[abc')).toBe(false)
  })
})

describe('createExpoPushSender', () => {
  it('chunks, maps tickets back by index and refuses non-Expo tokens locally', async () => {
    const expo = fakeExpo(2)
    const sender = createExpoPushSender(expo)
    const tickets = await sender.send([
      message('ExponentPushToken[a]'),
      message('apns-raw'),
      message('ExponentPushToken[dead]'),
      message('ExponentPushToken[b]'),
      message('ExponentPushToken[c]'),
    ])
    expect(expo.sent.map((c) => c.length)).toEqual([2, 2])
    expect(expo.sent[0]?.[0]).toMatchObject({
      to: 'ExponentPushToken[a]',
      title: 't',
      body: 'b',
      priority: 'high',
      sound: 'default',
      channelId: 'social',
      data: { type: 'follow' },
    })
    expect(tickets).toEqual([
      { status: 'ok', id: '1-0' },
      {
        status: 'error',
        message: INVALID_TOKEN_MESSAGE,
        details: { error: 'DeviceNotRegistered', expoPushToken: 'apns-raw' },
      },
      {
        status: 'error',
        message: 'not registered',
        details: { error: 'DeviceNotRegistered', expoPushToken: 'ExponentPushToken[dead]' },
      },
      { status: 'ok', id: '2-0' },
      { status: 'ok', id: '2-1' },
    ])
  })

  it('turns a failed chunk request into transient tickets for that chunk only', async () => {
    const expo = fakeExpo(2)
    expo.failChunk = 0
    const sender = createExpoPushSender(expo)
    const tickets = await sender.send([
      message('ExponentPushToken[a]'),
      message('ExponentPushToken[b]'),
      message('ExponentPushToken[c]'),
    ])
    expect(tickets[0]).toEqual({
      status: 'error',
      message: `${CHUNK_FAILED_MESSAGE}: gateway timeout`,
      transient: true,
    })
    expect(tickets[1]).toMatchObject({ status: 'error', transient: true })
    expect(tickets[2]).toEqual({ status: 'ok', id: '2-0' })
  })

  it('fetches receipts when the client supports it', async () => {
    const sender = createExpoPushSender(fakeExpo(10))
    await expect(sender.receipts?.(['1-good', '1-bad'])).resolves.toEqual({
      '1-good': { status: 'ok' },
      '1-bad': { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } },
    })
    await expect(sender.receipts?.([])).resolves.toEqual({})
  })
})
