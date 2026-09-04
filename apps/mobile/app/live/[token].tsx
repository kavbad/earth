/**
 * `/live/[token]` — a room link opened on a phone with Earth installed (spec §112; SCREEN 17):
 * the preview, then "Join them" for Humans through `room_invite_join`. Guests join from the web;
 * a Visitor sees the preview with "Claim your place" and the way to the web Guest page.
 */
import { useLocalSearchParams } from 'expo-router'

import { RoomInviteScreen } from '@/components/rooms/RoomInviteScreen'
import { firstParam } from '@/lib/routes'

export default function RoomInviteRoute() {
  const params = useLocalSearchParams<{ token?: string | string[] }>()
  return <RoomInviteScreen token={firstParam(params.token)} />
}
