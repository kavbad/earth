/** Routes of the Live and room screens (SCREEN 13–16), spelled once. */
export const LIVE_ROUTE = '/live' as const
export const CHATS_ROUTE = '/chats' as const

/** `/rooms/<roomId>` — the active room (SCREEN 14). */
export function roomRoute(roomId: string): string {
  return `/rooms/${encodeURIComponent(roomId)}`
}

/** `/chats/<conversationId>` — the group's conversation behind a room. */
export function conversationRoute(conversationId: string): string {
  return `${CHATS_ROUTE}/${encodeURIComponent(conversationId)}`
}
