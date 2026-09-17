'use client'

/**
 * "Maya + 2 live" on a chats row (SCREEN 08) and "3 live · Join" on a group header (SCREEN 10):
 * the summary only carries `activeRoom { roomId, participantCount }`, so the names come from
 * `room_get` — one cached read per live room, ordered for the viewer (spec §60).
 */
import type { RoomDto, RoomId } from '@earth/domain'
import { orderParticipantsForViewer } from '@earth/domain'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

import { useEarth, useRuntime } from '../../../lib/providers/RuntimeProvider'

export const ACTIVE_ROOM_STALE_MS = 15_000

export interface ActiveRoomNames {
  readonly names: readonly string[]
  readonly total: number
  readonly room: RoomDto | null
}

export function roomNamesForViewer(room: RoomDto): ActiveRoomNames {
  const ordered = orderParticipantsForViewer(
    room.participants.map((participant) => ({
      id: participant.id,
      displayName: participant.displayName,
      isGuest: participant.isGuest,
      mediaState: participant.mediaState,
      status: participant.status,
      relation: participant.relationToViewer,
      joinedAt: participant.joinedAt,
    })),
  )
  return { names: ordered.map((p) => p.displayName), total: ordered.length, room }
}

export function useActiveRoomNames(roomId: RoomId | null, fallbackCount: number): ActiveRoomNames {
  const earth = useEarth()
  const { runtime } = useRuntime()
  const query = useQuery({
    queryKey: ['room', roomId, 'names'],
    queryFn: () => earth.rooms.get(roomId as RoomId),
    enabled: runtime !== null && roomId !== null,
    staleTime: ACTIVE_ROOM_STALE_MS,
    refetchInterval: roomId === null ? false : ACTIVE_ROOM_STALE_MS,
  })
  return useMemo(() => {
    if (query.data === undefined) return { names: [], total: fallbackCount, room: null }
    const named = roomNamesForViewer(query.data)
    return named.total === 0 ? { ...named, total: fallbackCount } : named
  }, [query.data, fallbackCount])
}
