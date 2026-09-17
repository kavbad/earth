import { PRESENCE_PING_INTERVAL_SECONDS, type RoomId } from '@earth/domain'
import { useEffect } from 'react'
import { AppState } from 'react-native'

import { useRoomShell } from '../shell'

/** `presence_ping(room_id)` every 30 s while connected and in the foreground (ARCHITECTURE §8, §11). */
export function useRoomPresence(roomId: RoomId, active: boolean): void {
  const { earth } = useRoomShell()
  useEffect(() => {
    if (!active) return
    const ping = () => {
      if (AppState.currentState !== 'active') return
      earth.presence.ping({ roomId }).catch(() => {
        // Presence is best-effort; the next tick tries again.
      })
    }
    ping()
    const timer = setInterval(ping, PRESENCE_PING_INTERVAL_SECONDS * 1_000)
    return () => clearInterval(timer)
  }, [earth, roomId, active])
}
