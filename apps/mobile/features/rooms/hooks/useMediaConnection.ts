/**
 * The LiveKit leg of a room (spec §9, §109; ARCHITECTURE §8, §10): mints a token through the
 * typed client, drives `connectLiveKit` from `@earth/realtime` (reconnect policy, diagnostics,
 * offline awareness) and exposes the SDK `Room` for the stage plus the local media controls.
 * The native audio session (`features/rooms/livekit.ts`) is configured before each connection
 * and runs while connected, so audio survives the app going to the background.
 *
 * Permissions are carried by the token (`room_media_grant`): after a media-state change the
 * caller asks for a fresh token with `reconnect(roomId)` — one token per join.
 */
import type { MediaIdentity, RoomId } from '@earth/domain'
import {
  type LiveKitConnection,
  type LiveKitConnectionState,
  type LiveKitStateDetail,
  type MediaToggleResult,
  connectLiveKit,
} from '@earth/realtime'
import { LocalVideoTrack, Room, Track } from 'livekit-client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { errorCode } from '@/lib/errors'

import { configureRoomAudio, startRoomAudio, stopRoomAudio } from '../livekit'
import { useRoomShell } from '../shell'
import { MEDIA_STATUSES, type MediaStatus } from '../state/connection'
import { useRtcDiagnostics } from './useRtcDiagnostics'

export { MEDIA_STATUSES }
export type { MediaStatus }

export const FACING_MODES = ['user', 'environment'] as const
export type FacingMode = (typeof FACING_MODES)[number]

export type MediaPermissionProblem = 'microphone' | 'camera'

export interface MediaConnection {
  readonly status: MediaStatus
  readonly detail: LiveKitStateDetail
  /** The SDK room while a connection exists (for the stage); `null` before the first connect. */
  readonly livekitRoom: Room | null
  readonly identity: MediaIdentity | null
  readonly micEnabled: boolean
  readonly cameraEnabled: boolean
  readonly facing: FacingMode
  readonly permissionProblem: MediaPermissionProblem | null
  /** Mints a token for `roomId` and connects; resolves `true` once connected. */
  connect(roomId: RoomId): Promise<boolean>
  /** Leaves the current SDK room and connects again with a fresh token (new permissions). */
  reconnect(roomId: RoomId): Promise<boolean>
  /** "Try again" (spec §109). */
  retry(): Promise<boolean>
  disconnect(): Promise<void>
  setMicrophone(enabled: boolean): Promise<MediaToggleResult>
  setCamera(enabled: boolean): Promise<MediaToggleResult>
  /** Front ↔ back camera; resolves `false` when there is no camera track to flip. */
  flipCamera(): Promise<boolean>
}

const NO_DETAIL: LiveKitStateDetail = {}

function createSdkRoom(facing: FacingMode): Room {
  return new Room({
    adaptiveStream: { pixelDensity: 'screen' },
    dynacast: true,
    videoCaptureDefaults: { facingMode: facing },
  })
}

export function useMediaConnection(): MediaConnection {
  const { earth, online } = useRoomShell()
  const diagnostics = useRtcDiagnostics()
  const onlineRef = useRef(online)
  useEffect(() => {
    onlineRef.current = online
  }, [online])

  const [status, setStatus] = useState<MediaStatus>('idle')
  const [detail, setDetail] = useState<LiveKitStateDetail>(NO_DETAIL)
  const [livekitRoom, setLivekitRoom] = useState<Room | null>(null)
  const [identity, setIdentity] = useState<MediaIdentity | null>(null)
  const [micEnabled, setMicEnabled] = useState(false)
  const [cameraEnabled, setCameraEnabled] = useState(false)
  const [facing, setFacing] = useState<FacingMode>('user')
  const [permissionProblem, setPermissionProblem] = useState<MediaPermissionProblem | null>(null)

  const connection = useRef<LiveKitConnection | null>(null)
  const sdkRoom = useRef<Room | null>(null)
  const lastRoomId = useRef<RoomId | null>(null)
  const facingRef = useRef<FacingMode>('user')

  const teardown = useCallback(async () => {
    const current = connection.current
    connection.current = null
    sdkRoom.current = null
    if (current !== null) await current.disconnect()
    await stopRoomAudio()
    setLivekitRoom(null)
    setMicEnabled(false)
    setCameraEnabled(false)
  }, [])

  const connect = useCallback(
    async (roomId: RoomId): Promise<boolean> => {
      lastRoomId.current = roomId
      await teardown()
      setStatus('connecting')
      setDetail(NO_DETAIL)
      let grant
      try {
        grant = await earth.rooms.token(roomId)
      } catch (cause) {
        const code = errorCode(cause)
        setStatus('failed')
        setDetail({ code, reason: 'token' })
        diagnostics.emit({ kind: 'connect_failed', roomId, code, reason: 'token' })
        return false
      }
      await configureRoomAudio()
      await startRoomAudio()
      const room = createSdkRoom(facingRef.current)
      sdkRoom.current = room
      setLivekitRoom(room)
      setIdentity(grant.identity)
      const handle = connectLiveKit({
        createRoom: () => room,
        url: grant.url,
        token: grant.token,
        roomId,
        participantIdentity: grant.identity,
        diagnostics,
        isOnline: () => onlineRef.current,
        onState(next: LiveKitConnectionState, info) {
          if (connection.current !== handle && connection.current !== null) return
          setStatus(next)
          setDetail(info)
        },
      })
      connection.current = handle
      const settled = await handle.settled()
      return settled === 'connected'
    },
    [earth, diagnostics, teardown],
  )

  const retry = useCallback(async (): Promise<boolean> => {
    const current = connection.current
    if (current !== null && (current.state() === 'failed' || current.state() === 'disconnected')) {
      const state = await current.retry()
      return state === 'connected'
    }
    if (current === null && lastRoomId.current !== null) return connect(lastRoomId.current)
    return current?.state() === 'connected'
  }, [connect])

  const disconnect = useCallback(async () => {
    await teardown()
    setStatus('disconnected')
    setDetail({ code: 'CLIENT_INITIATED' })
  }, [teardown])

  const setMicrophone = useCallback(async (enabled: boolean): Promise<MediaToggleResult> => {
    const current = connection.current
    if (current === null) return { ok: false, kind: 'track_publish_failed', error: 'not_connected' }
    const result = await current.setMicrophoneEnabled(enabled)
    if (result.ok) {
      setMicEnabled(sdkRoom.current?.localParticipant.isMicrophoneEnabled ?? enabled)
      setPermissionProblem((p) => (p === 'microphone' ? null : p))
    } else if (result.kind === 'media_permission_denied') {
      setPermissionProblem('microphone')
    }
    return result
  }, [])

  const setCamera = useCallback(async (enabled: boolean): Promise<MediaToggleResult> => {
    const current = connection.current
    if (current === null) return { ok: false, kind: 'track_publish_failed', error: 'not_connected' }
    const result = await current.setCameraEnabled(enabled)
    if (result.ok) {
      setCameraEnabled(sdkRoom.current?.localParticipant.isCameraEnabled ?? enabled)
      setPermissionProblem((p) => (p === 'camera' ? null : p))
    } else if (result.kind === 'media_permission_denied') {
      setPermissionProblem('camera')
    }
    return result
  }, [])

  const flipCamera = useCallback(async (): Promise<boolean> => {
    const room = sdkRoom.current
    const track = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track
    if (!(track instanceof LocalVideoTrack)) return false
    const next: FacingMode = facingRef.current === 'user' ? 'environment' : 'user'
    try {
      await track.restartTrack({ facingMode: next })
      facingRef.current = next
      setFacing(next)
      return true
    } catch (cause) {
      diagnostics.emit({
        kind: 'media_device_error',
        source: 'camera',
        reason: cause instanceof Error ? cause.name : 'flip_failed',
      })
      return false
    }
  }, [diagnostics])

  useEffect(
    () => () => {
      void teardown()
    },
    [teardown],
  )

  return useMemo<MediaConnection>(
    () => ({
      status,
      detail,
      livekitRoom,
      identity,
      micEnabled,
      cameraEnabled,
      facing,
      permissionProblem,
      connect,
      reconnect: connect,
      retry,
      disconnect,
      setMicrophone,
      setCamera,
      flipCamera,
    }),
    [
      status,
      detail,
      livekitRoom,
      identity,
      micEnabled,
      cameraEnabled,
      facing,
      permissionProblem,
      connect,
      retry,
      disconnect,
      setMicrophone,
      setCamera,
      flipCamera,
    ],
  )
}
