/**
 * The stage tiles of a room, kept by the pure `tilesReducer`: every room snapshot from
 * `subscribeRoom` is reconciled during render (surviving tiles keep their slot), and participant
 * deltas are applied as they arrive so a join, a leave or a camera change moves exactly one tile.
 */
import type { RoomDto } from '@earth/domain'
import { type RoomStateDelta, participantDeltas } from '@earth/realtime'
import { useCallback, useMemo, useState } from 'react'

import { EMPTY_TILES, type RoomTile, type TilesState, tileList, tilesReducer } from '../state/tiles'

export interface RoomTilesStore {
  /** Applies realtime participant deltas (event time, not render time). */
  applyDeltas(deltas: readonly RoomStateDelta[], selfParticipantId: string | null): void
  /** Reconciles the latest room during render and returns the tiles in display order. */
  reconcile(
    room: Pick<RoomDto, 'participants'> | null,
    selfParticipantId: string | null,
  ): RoomTile[]
}

export function useRoomTiles(): RoomTilesStore {
  const [state, setState] = useState<TilesState>(EMPTY_TILES)

  const applyDeltas = useCallback(
    (deltas: readonly RoomStateDelta[], selfParticipantId: string | null) => {
      const changes = participantDeltas(deltas)
      if (changes.length === 0) return
      setState((current) =>
        tilesReducer(current, { type: 'deltas', deltas: changes, selfParticipantId }),
      )
    },
    [],
  )

  const reconcile = useCallback(
    (room: Pick<RoomDto, 'participants'> | null, selfParticipantId: string | null): RoomTile[] => {
      const next =
        room === null
          ? tilesReducer(state, { type: 'reset' })
          : tilesReducer(state, { type: 'snapshot', room, selfParticipantId })
      // Adjusting state during render: React re-renders at once with the reconciled tiles.
      if (next !== state) setState(next)
      return tileList(next)
    },
    [state],
  )

  return useMemo(() => ({ applyDeltas, reconcile }), [applyDeltas, reconcile])
}
