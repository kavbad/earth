/**
 * `/rooms/join?token=…` — the same room-link preview as `/live/[token]` (SCREEN 17 in the app)
 * for links the app opens itself, e.g. a pasted `earth.social/live/…` URL from the composer or
 * a notification that carries the invite token rather than the room id.
 */
import { useLocalSearchParams } from 'expo-router'

import { RoomInviteScreen } from '@/components/rooms/RoomInviteScreen'
import { firstParam } from '@/lib/routes'

export default function RoomJoinRoute() {
  const params = useLocalSearchParams<{ token?: string | string[] }>()
  return <RoomInviteScreen token={firstParam(params.token)} />
}
