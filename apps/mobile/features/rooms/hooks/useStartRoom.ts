/**
 * `room_start` for the surfaces that create rooms (a group's camera tap, spec §57): returns the
 * existing active room for the context or a new one, tracks `room_created` when it was created,
 * and opens SCREEN 14.
 */
import type { RoomStartArgs } from '@earth/api'
import { type RoomDto, asGroupId } from '@earth/domain'
import { useRouter } from 'expo-router'
import { useCallback } from 'react'

import { roomRoute } from '../routes'
import { useRoomShell } from '../shell'

export interface StartRoomOptions {
  /** Navigate to the room once it exists (default `true`). */
  readonly open?: boolean
}

export function useStartRoom(): (
  input: RoomStartArgs,
  options?: StartRoomOptions,
) => Promise<RoomDto> {
  const { earth, track } = useRoomShell()
  const router = useRouter()
  return useCallback(
    async (input, options = {}) => {
      const result = await earth.rooms.start(input)
      if (result.created) {
        track('room_created', {
          roomId: result.room.id,
          contextType: result.room.contextType,
          ...(result.room.contextType === 'group' && result.room.contextId !== null
            ? { groupId: asGroupId(result.room.contextId) }
            : {}),
          visibility: result.room.visibility,
          joinPolicy: result.room.joinPolicy,
        })
      }
      if (options.open !== false) router.push(roomRoute(result.room.id))
      return result.room
    },
    [earth, track, router],
  )
}
