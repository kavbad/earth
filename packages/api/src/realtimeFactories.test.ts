import { asConversationId, asMessageId, asRoomId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  conversationFetchSince,
  createRealtimeFactories,
  presencePingFor,
  roomFetchState,
} from './realtimeFactories'
import { RPC } from './rpc'
import * as fixtures from './testing/fixtures'
import { createTestClient } from './testing/harness'

const { IDS } = fixtures
const CONVERSATION = asConversationId(IDS.conversation)
const ROOM = asRoomId(IDS.room)

describe('realtime factories', () => {
  it('fetchSince polls messages_since for the bound conversation', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.messagesSince, [fixtures.messageDto()])
    const fetchSince = conversationFetchSince(client, CONVERSATION)
    expect(await fetchSince(null)).toHaveLength(1)
    expect(supabase.lastRpc()).toEqual({
      name: 'messages_since',
      args: { conversation_id: IDS.conversation, after_id: null },
    })
    await fetchSince(asMessageId(IDS.message))
    expect(supabase.lastRpc().args).toEqual({
      conversation_id: IDS.conversation,
      after_id: IDS.message,
    })
  })

  it('fetchState re-fetches room_get for the bound room', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.roomGet, fixtures.roomDto())
    const room = await roomFetchState(client, ROOM)()
    expect(room.id).toBe(IDS.room)
    expect(supabase.lastRpc()).toEqual({ name: 'room_get', args: { room_id: IDS.room } })
  })

  it('presencePing matches createPresencePinger(conversationId, roomId)', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.presencePing, null)
    await presencePingFor(client)(CONVERSATION, null)
    expect(supabase.lastRpc()).toEqual({
      name: 'presence_ping',
      args: { conversation_id: IDS.conversation, room_id: null, platform: null },
    })
  })

  it('createRealtimeFactories bundles the three closures', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.messagesSince, [])
    supabase.rpcData(RPC.roomGet, fixtures.roomDto())
    supabase.rpcData(RPC.presencePing, null)
    const factories = createRealtimeFactories(client)
    expect(await factories.fetchSince(CONVERSATION)(null)).toEqual([])
    expect((await factories.fetchState(ROOM)()).id).toBe(IDS.room)
    await factories.presencePing(null, ROOM)
    expect(supabase.rpcCalls.map((call) => call.name)).toEqual([
      'messages_since',
      'room_get',
      'presence_ping',
    ])
  })
})
