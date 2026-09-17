/**
 * Closures `@earth/realtime` subscriptions need, bound to an `EarthClient` (ARCHITECTURE §8):
 * `subscribeConversation({ fetchSince })`, `subscribeRoom({ fetchState })` and
 * `createPresencePinger({ presencePing })`. Kept here so apps wire realtime without touching RPC names.
 */
import type { ConversationId, MessageDto, MessageId, RoomDto, RoomId } from '@earth/domain'

import type { EarthClient } from './client'

/** `messages_since(conversation_id, after_id)` bound to one conversation. */
export type FetchSince = (afterId: MessageId | null) => Promise<readonly MessageDto[]>

/** `room_get(room_id)` bound to one room. */
export type FetchRoomState = () => Promise<RoomDto>

/** `presence_ping(conversation_id, room_id)` in the shape `createPresencePinger` expects. */
export type PresencePing = (
  conversationId: ConversationId | null,
  roomId: RoomId | null,
) => Promise<void>

export function conversationFetchSince(
  client: Pick<EarthClient, 'conversations'>,
  conversationId: ConversationId,
): FetchSince {
  return (afterId) => client.conversations.messages.since({ conversationId, afterId })
}

export function roomFetchState(client: Pick<EarthClient, 'rooms'>, roomId: RoomId): FetchRoomState {
  return () => client.rooms.get(roomId)
}

export function presencePingFor(client: Pick<EarthClient, 'presence'>): PresencePing {
  return (conversationId, roomId) => client.presence.ping({ conversationId, roomId })
}

export interface RealtimeFactories {
  fetchSince(conversationId: ConversationId): FetchSince
  fetchState(roomId: RoomId): FetchRoomState
  readonly presencePing: PresencePing
}

export function createRealtimeFactories(
  client: Pick<EarthClient, 'conversations' | 'rooms' | 'presence'>,
): RealtimeFactories {
  return {
    fetchSince: (conversationId) => conversationFetchSince(client, conversationId),
    fetchState: (roomId) => roomFetchState(client, roomId),
    presencePing: presencePingFor(client),
  }
}
