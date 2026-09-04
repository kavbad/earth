'use client'

/**
 * SCREEN 18 — the Guest inside the room: same stage, "Guest" next to the name, controls limited
 * to audio, camera, flip, participants, leave (and report). No Open up, no invites, no
 * moderation. Loaded on the client only (LiveKit is browser-only).
 */
import type { GuestOutcome } from '@earth/analytics'
import {
  type ReportReason,
  type RoomDto,
  type RoomId,
  type RoomParticipantDto,
} from '@earth/domain'
import type { RoomStateDelta } from '@earth/realtime'
import { useCallback, useEffect, useRef, useState } from 'react'

import { webCopy } from '../../lib/copy'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useEarth } from '../../lib/providers/RuntimeProvider'
import { Spinner } from '../ui/Spinner'
import { useToast } from '../ui/Toast'
import { MoreSheet } from './MoreSheet'
import { ParticipantsSheet, reportTargetForParticipant } from './ParticipantsSheet'
import { ReportSheet } from './ReportSheet'
import { RoomEnded } from './RoomEnded'
import { RoomView } from './RoomView'
import { roomCopy } from './copy'
import { guestRoomRoute } from './routes'
import { useMediaConnection } from './hooks/useMediaConnection'
import { useRetryWhenOnline } from './hooks/useRetryWhenOnline'
import { useRoomPresence } from './hooks/useRoomPresence'
import { useRoomState } from './hooks/useRoomState'

export interface GuestInRoomProps {
  readonly token: string
  readonly roomId: RoomId
  readonly wantsCamera: boolean
  readonly onLeft: (outcome: GuestOutcome) => void
}

type SheetKind = 'none' | 'participants' | 'more' | 'report'

/** The room, or one person in it: a Guest reports both (spec §81, DB_API §7). */
type ReportTarget =
  | { readonly kind: 'room' }
  | {
      readonly kind: 'participant'
      readonly target: NonNullable<ReturnType<typeof reportTargetForParticipant>>
      readonly name: string
    }

const ROOM_REPORT_TARGET: ReportTarget = { kind: 'room' }

export function GuestInRoom({ token, roomId, wantsCamera, onLeft }: GuestInRoomProps) {
  const earth = useEarth()
  const analytics = useAnalytics()
  const toast = useToast()
  const media = useMediaConnection()
  useRetryWhenOnline(media)
  const [sheet, setSheet] = useState<SheetKind>('none')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [reportDone, setReportDone] = useState(false)
  const [reportTarget, setReportTarget] = useState<ReportTarget>(ROOM_REPORT_TARGET)
  const connected = useRef(false)
  const left = useRef(false)
  const onLeftRef = useRef(onLeft)
  useEffect(() => {
    onLeftRef.current = onLeft
  })

  const finish = useCallback(
    async (outcome: GuestOutcome) => {
      if (left.current) return
      left.current = true
      await media.disconnect()
      onLeftRef.current(outcome)
    },
    [media],
  )

  const onDeltas = useCallback(
    (room: RoomDto, deltas: readonly RoomStateDelta[]) => {
      const meId = room.myParticipant?.id
      for (const delta of deltas) {
        if (delta.kind === 'room_ended') void finish('room_ended')
        if (
          delta.kind === 'participant_left' &&
          delta.participant.id === meId &&
          delta.participant.status === 'removed'
        ) {
          void finish('removed')
        }
      }
    },
    [finish],
  )

  const roomState = useRoomState({ roomId, enabled: true, onDeltas })
  const room = roomState.room
  useRoomPresence(roomId, media.status === 'connected')

  useEffect(() => {
    if (connected.current) return
    connected.current = true
    const enter = async () => {
      const ok = await media.connect(roomId)
      if (!ok) return
      const mic = await media.setMicrophone(true)
      if (!mic.ok)
        setNotice(
          mic.kind === 'media_permission_denied' ? roomCopy.micPermission : roomCopy.couldntChange,
        )
      if (wantsCamera) {
        const cam = await media.setCamera(true)
        if (!cam.ok) {
          setNotice(
            cam.kind === 'media_permission_denied'
              ? roomCopy.cameraPermission
              : roomCopy.couldntChange,
          )
          await earth.rooms.setMediaState({ roomId, mediaState: 'audio' }).catch(() => undefined)
        }
      }
    }
    void enter()
  }, [media, roomId, wantsCamera, earth])

  useEffect(() => {
    if (roomState.error === 'room_ended' || room?.status === 'ended') void finish('room_ended')
  }, [roomState.error, room?.status, finish])

  const leave = useCallback(async () => {
    await earth.rooms.leave(roomId).catch(() => undefined)
    await finish('left')
  }, [earth, roomId, finish])

  const toggleCamera = useCallback(async () => {
    const next = !media.cameraEnabled
    const result = await media.setCamera(next)
    if (!result.ok) {
      setNotice(
        result.kind === 'media_permission_denied'
          ? roomCopy.cameraPermission
          : roomCopy.couldntChange,
      )
      return
    }
    await earth.rooms
      .setMediaState({ roomId, mediaState: next ? 'camera' : 'audio' })
      .catch(() => undefined)
    await roomState.refresh()
  }, [media, earth, roomId, roomState])

  const report = useCallback(
    async (reason: ReportReason) => {
      const target =
        reportTarget.kind === 'room' ? { type: 'room' as const, id: roomId } : reportTarget.target
      setBusy(true)
      try {
        await earth.safety.report({
          targetType: target.type,
          targetId: target.id,
          reason,
          details: null,
        })
        analytics.track('content_reported', { targetType: target.type, reason })
        setReportDone(true)
      } catch {
        toast.show(webCopy.somethingWrong)
      } finally {
        setBusy(false)
      }
    },
    [earth, roomId, reportTarget, analytics, toast],
  )

  const reportParticipant = useCallback((participant: RoomParticipantDto) => {
    const target = reportTargetForParticipant(participant)
    if (target === null) return
    setReportDone(false)
    setReportTarget({ kind: 'participant', target, name: participant.displayName })
    setSheet('report')
  }, [])

  if (room === null) {
    if (roomState.error !== null && roomState.error !== 'room_ended') {
      return (
        <RoomEnded
          kind="error"
          backHref={guestRoomRoute(token)}
          onRetry={() => void roomState.refresh()}
        />
      )
    }
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <Spinner label={roomCopy.joiningRoom} />
      </div>
    )
  }

  return (
    <RoomView
      room={room}
      media={media}
      mode="guest"
      canOpenUp={false}
      busy={busy}
      notice={notice}
      onMic={() => void media.setMicrophone(!media.micEnabled)}
      onCamera={() => void toggleCamera()}
      onFlip={() => void media.flipCamera()}
      onParticipants={() => setSheet('participants')}
      onOpenUp={() => undefined}
      onMore={() => setSheet('more')}
      onLeave={() => void leave()}
      onRetry={() => void media.retry()}
    >
      <ParticipantsSheet
        open={sheet === 'participants'}
        participants={room.participants}
        meId={room.myParticipant?.id ?? null}
        canModerate={false}
        onRemove={() => undefined}
        onAdmit={() => undefined}
        onReport={reportParticipant}
        onClose={() => setSheet('none')}
      />
      <MoreSheet
        open={sheet === 'more'}
        canModerate={false}
        isGuest
        guestsDisabled={room.guestsDisabled}
        shareUrl={null}
        busy={busy}
        onShare={() => undefined}
        onToggleGuests={() => undefined}
        onEnd={() => undefined}
        onReport={() => {
          setReportDone(false)
          setReportTarget(ROOM_REPORT_TARGET)
          setSheet('report')
        }}
        onLeave={() => void leave()}
        onClose={() => setSheet('none')}
      />
      <ReportSheet
        open={sheet === 'report'}
        title={
          reportTarget.kind === 'room'
            ? roomCopy.reportTitle
            : roomCopy.reportPersonTitle(reportTarget.name)
        }
        busy={busy}
        done={reportDone}
        onReport={(reason) => void report(reason)}
        onClose={() => setSheet('none')}
      />
    </RoomView>
  )
}
