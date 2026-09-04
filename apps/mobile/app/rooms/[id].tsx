/**
 * `/rooms/[id]` — SCREEN 14, the Active Room. Lives outside the tabs so the stage owns the whole
 * viewport; keyed by id so moving between rooms remounts the stage. The LiveKit globals are
 * registered by the first import below, before any room can connect.
 */
import '@/features/rooms/livekit'

import { asRoomId, isUuid } from '@earth/domain'
import { colors } from '@earth/ui'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { StyleSheet, View } from 'react-native'

import { RoomEnded } from '@/components/rooms/RoomEnded'
import { RoomScreen } from '@/components/rooms/RoomScreen'
import { LIVE_ROUTE } from '@/features/rooms/routes'
import { firstParam } from '@/lib/routes'

export default function RoomRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>()
  const router = useRouter()
  const id = firstParam(params.id)
  if (id === null || !isUuid(id)) {
    return (
      <View style={styles.screen}>
        <RoomEnded kind="not_visible" onBack={() => router.replace(LIVE_ROUTE)} />
      </View>
    )
  }
  return <RoomScreen key={id} roomId={asRoomId(id)} />
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
})
