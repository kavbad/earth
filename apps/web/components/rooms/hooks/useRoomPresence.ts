'use client'

import { PRESENCE_PING_INTERVAL_SECONDS, type RoomId } from '@earth/domain'
import { useEffect } from 'react'

import { useEarth } from '../../../lib/providers/RuntimeProvider'

/** `presence_ping(room_id)` every 30 s while connected (ARCHITECTURE §8, §11). */
export function useRoomPresence(roomId: RoomId, active: boolean): void {
  const earth = useEarth()
  useEffect(() => {
    if (!active) return
    const ping = () => {
      earth.presence.ping({ roomId }).catch(() => {
        // Presence is best-effort; the next tick tries again.
      })
    }
    ping()
    const timer = setInterval(ping, PRESENCE_PING_INTERVAL_SECONDS * 1_000)
    return () => clearInterval(timer)
  }, [earth, roomId, active])
}
