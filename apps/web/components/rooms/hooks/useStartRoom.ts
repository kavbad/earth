'use client'

/**
 * `room_start` for the surfaces that create rooms (a group's camera tap, spec §57): returns the
 * existing active room for the context or a new one, tracks `room_created` when it was created,
 * and opens SCREEN 14. Exported for the chats/group agent; the room screens never start rooms.
 */
import type { RoomStartArgs } from '@earth/api'
import { type GroupId, type RoomDto } from '@earth/domain'
import { useRouter } from 'next/navigation'
import { useCallback } from 'react'

import { useAnalytics } from '../../../lib/providers/AnalyticsProvider'
import { useEarth } from '../../../lib/providers/RuntimeProvider'
import { roomRoute } from '../routes'

export interface StartRoomOptions {
  /** Navigate to the room once it exists (default `true`). */
  readonly open?: boolean
}

export function useStartRoom(): (
  input: RoomStartArgs,
  options?: StartRoomOptions,
) => Promise<RoomDto> {
  const earth = useEarth()
  const analytics = useAnalytics()
  const router = useRouter()
  return useCallback(
    async (input, options = {}) => {
      const result = await earth.rooms.start(input)
      if (result.created) {
        analytics.track('room_created', {
          roomId: result.room.id,
          contextType: result.room.contextType,
          ...(result.room.contextType === 'group' && result.room.contextId !== null
            ? { groupId: result.room.contextId as GroupId }
            : {}),
          visibility: result.room.visibility,
          joinPolicy: result.room.joinPolicy,
        })
      }
      if (options.open !== false) router.push(roomRoute(result.room.id))
      return result.room
    },
    [earth, analytics, router],
  )
}
