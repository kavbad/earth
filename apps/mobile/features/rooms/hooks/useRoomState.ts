/**
 * The room as the viewer sees it (`room_get`), kept current by `subscribeRoom` from
 * `@earth/realtime` (Realtime with polling fallback, ARCHITECTURE §8). The first read goes
 * through `earth.rooms.get` so its error code (`not_visible`, `room_ended`, …) reaches the screen.
 */
import { roomFetchState } from '@earth/api'
import type { EarthErrorCode, RoomDto, RoomId } from '@earth/domain'
import { type RealtimeMode, type RoomStateDelta, subscribeRoom } from '@earth/realtime'
import { useCallback, useEffect, useRef, useState } from 'react'

import { errorCode } from '@/lib/errors'

import { useRoomShell } from '../shell'
import { useRtcDiagnostics } from './useRtcDiagnostics'

export type RoomDeltasHandler = (room: RoomDto, deltas: readonly RoomStateDelta[]) => void

export interface UseRoomStateOptions {
  readonly roomId: RoomId
  /** Off until the person may read the room (a session exists). */
  readonly enabled: boolean
  readonly onDeltas?: RoomDeltasHandler
}

export interface RoomStateHandle {
  readonly room: RoomDto | null
  readonly error: EarthErrorCode | null
  /** `true` until the first read answered (with a room or an error). */
  readonly loading: boolean
  readonly mode: RealtimeMode | null
  /** Replaces the local state (after `room_join`, `room_set_media_state`, …). */
  setRoom(room: RoomDto): void
  refresh(): Promise<void>
}

interface Snapshot {
  readonly roomId: RoomId
  readonly room: RoomDto | null
  readonly error: EarthErrorCode | null
  readonly loading: boolean
  readonly mode: RealtimeMode | null
}

function initialSnapshot(roomId: RoomId): Snapshot {
  return { roomId, room: null, error: null, loading: true, mode: null }
}

export function useRoomState(options: UseRoomStateOptions): RoomStateHandle {
  const { roomId, enabled } = options
  const { earth, supabase } = useRoomShell()
  const diagnostics = useRtcDiagnostics()
  const [snapshot, setSnapshot] = useState<Snapshot>(() => initialSnapshot(roomId))
  // A different room resets the state during render (React's "adjusting state" pattern).
  if (snapshot.roomId !== roomId) setSnapshot(initialSnapshot(roomId))
  const onDeltas = useRef<RoomDeltasHandler | undefined>(options.onDeltas)
  useEffect(() => {
    onDeltas.current = options.onDeltas
  })
  const subscription = useRef<ReturnType<typeof subscribeRoom> | null>(null)

  useEffect(() => {
    if (!enabled || supabase === null) return
    let cancelled = false
    const fetchState = roomFetchState(earth, roomId)
    const start = async () => {
      let first: RoomDto | null = null
      try {
        first = await fetchState()
        if (cancelled) return
        const loaded = first
        setSnapshot((s) => ({ ...s, room: loaded, error: null, loading: false }))
      } catch (cause) {
        if (cancelled) return
        const code = errorCode(cause)
        setSnapshot((s) => ({ ...s, error: code, loading: false }))
        return
      }
      const handle = subscribeRoom({
        supabase,
        roomId,
        fetchState,
        diagnostics,
        initialState: first,
        onRoom(next, deltas) {
          setSnapshot((s) => ({ ...s, room: next, mode: handle.mode() }))
          if (deltas.length > 0) onDeltas.current?.(next, deltas)
        },
        onStatus() {
          setSnapshot((s) => ({ ...s, mode: handle.mode() }))
        },
      })
      subscription.current = handle
    }
    void start()
    return () => {
      cancelled = true
      subscription.current?.unsubscribe()
      subscription.current = null
    }
  }, [enabled, supabase, earth, roomId, diagnostics])

  const setRoom = useCallback((next: RoomDto) => {
    setSnapshot((s) => ({ ...s, room: next }))
  }, [])

  const refresh = useCallback(async () => {
    const handle = subscription.current
    if (handle !== null) {
      await handle.refresh()
      return
    }
    try {
      const next = await earth.rooms.get(roomId)
      setSnapshot((s) => ({ ...s, room: next, error: null }))
    } catch (cause) {
      const code = errorCode(cause)
      setSnapshot((s) => ({ ...s, error: code }))
    }
  }, [earth, roomId])

  return {
    room: snapshot.room,
    error: snapshot.error,
    loading: snapshot.loading,
    mode: snapshot.mode,
    setRoom,
    refresh,
  }
}
