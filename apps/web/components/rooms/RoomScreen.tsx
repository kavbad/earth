'use client'

/**
 * SCREEN 14 — the Active Room for Humans and Visitors at `/rooms/[id]` (spec §57–§62, §109;
 * ARCHITECTURE §8, §10). A Human opens the room as a viewer (`room_join` watching → token →
 * subscribe-only LiveKit), then "Join them" → audio / camera through the consent rules; the room
 * state follows `subscribeRoom`. Visitors see faces and names and meet the claim sheet when they
 * try to act (spec §43). Guests have their own page (`/live/[token]`).
 */
import type { ConsentTrigger } from '@earth/analytics'
import {
  type GroupId,
  type MediaState,
  type ReportReason,
  type RoomDto,
  type RoomId,
  type RoomJoinPolicy,
  type RoomParticipantDto,
  type RoomVisibility,
} from '@earth/domain'
import type { RoomStateDelta } from '@earth/realtime'
import { copy } from '@earth/ui'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

import { webCopy } from '../../lib/copy'
import { errorCode } from '../../lib/errors'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useFlags } from '../../lib/providers/FlagsProvider'
import { useEarth } from '../../lib/providers/RuntimeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { TAB_ROUTES } from '../../lib/routes'
import { useClaimGate } from '../shell/ClaimSheet'
import { Icon } from '../ui/Icon'
import { Spinner } from '../ui/Spinner'
import { useToast } from '../ui/Toast'
import { ConsentSheet } from './ConsentSheet'
import { GroupChatDrawer } from './GroupChatDrawer'
import { MoreSheet } from './MoreSheet'
import { OpenUpSheet } from './OpenUpSheet'
import { ParticipantsSheet, reportTargetForParticipant } from './ParticipantsSheet'
import { ReportSheet } from './ReportSheet'
import { type RoomClosedKind, RoomEnded, closedKindForError } from './RoomEnded'
import { RoomView } from './RoomView'
import { type JoinMediaState, ViewerJoin } from './ViewerJoin'
import { roomCopy } from './copy'
import { useMediaConnection } from './hooks/useMediaConnection'
import { useRetryWhenOnline } from './hooks/useRetryWhenOnline'
import { useRoomPresence } from './hooks/useRoomPresence'
import { useRoomState } from './hooks/useRoomState'
import {
  VIEWER_CONSENT_LEVEL,
  becameModerator,
  canModerate,
  consentDecision,
  initiatorName,
  pendingConsentFor,
} from './state/consent'

export interface RoomScreenProps {
  readonly roomId: RoomId
}

type SheetKind = 'none' | 'participants' | 'openUp' | 'more' | 'report' | 'chat'

/** What the one report sheet is about: the room (SCREEN 14 More) or one participant (spec §81). */
type ReportTarget =
  | { readonly kind: 'room' }
  | {
      readonly kind: 'participant'
      readonly target: NonNullable<ReturnType<typeof reportTargetForParticipant>>
      readonly name: string
    }

const ROOM_REPORT_TARGET: ReportTarget = { kind: 'room' }

interface ConsentPrompt {
  readonly trigger: ConsentTrigger
  readonly level: RoomVisibility
  /** What the person asked for when the sheet opened (join trigger); `null` for a widening. */
  readonly mediaState: JoinMediaState | null
}

function groupIdOf(room: Pick<RoomDto, 'contextType' | 'contextId'>): GroupId | undefined {
  return room.contextType === 'group' && room.contextId !== null
    ? (room.contextId as GroupId)
    : undefined
}

function LoadingRoom() {
  return (
    <div className="flex h-dvh items-center justify-center bg-background">
      <Spinner />
    </div>
  )
}

export function RoomScreen({ roomId }: RoomScreenProps) {
  const earth = useEarth()
  const session = useSession()
  const analytics = useAnalytics()
  const flags = useFlags()
  const gate = useClaimGate()
  const toast = useToast()
  const router = useRouter()
  const media = useMediaConnection()
  useRetryWhenOnline(media)

  const isHuman = session.roleKind === 'human'
  const [closed, setClosed] = useState<RoomClosedKind | null>(null)
  const [sheet, setSheet] = useState<SheetKind>('none')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [consentPrompt, setConsentPrompt] = useState<ConsentPrompt | null>(null)
  const [answeredPending, setAnsweredPending] = useState<RoomVisibility | null>(null)
  const [openUpError, setOpenUpError] = useState<string | null>(null)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [reportDone, setReportDone] = useState(false)
  const [reportTarget, setReportTarget] = useState<ReportTarget>(ROOM_REPORT_TARGET)
  const [busyParticipant, setBusyParticipant] = useState<string | null>(null)

  const joinedAt = useRef<number | null>(null)
  const joinAttempted = useRef(false)
  const leftTracked = useRef(false)
  const myIdRef = useRef<string | null>(null)
  const shownConsent = useRef<Set<string>>(new Set())

  const trackLeft = useCallback(
    (reason: 'left' | 'ended' | 'removed') => {
      if (leftTracked.current || joinedAt.current === null) return
      leftTracked.current = true
      analytics.track('room_left', { roomId, durationMs: Date.now() - joinedAt.current, reason })
    },
    [analytics, roomId],
  )

  const closeWith = useCallback(
    async (kind: RoomClosedKind, reason: 'ended' | 'removed') => {
      trackLeft(reason)
      await media.disconnect()
      setClosed(kind)
    },
    [media, trackLeft],
  )

  const onDeltas = useCallback(
    (room: RoomDto, deltas: readonly RoomStateDelta[]) => {
      const meId = room.myParticipant?.id ?? myIdRef.current
      for (const delta of deltas) {
        if (delta.kind === 'room_ended') void closeWith('ended', 'ended')
        if (
          delta.kind === 'participant_left' &&
          delta.participant.id === meId &&
          delta.participant.status === 'removed'
        ) {
          void closeWith('removed', 'removed')
        }
        if (
          delta.kind === 'role_changed' &&
          delta.participant.id === meId &&
          becameModerator(delta.previous, delta.participant.role)
        ) {
          toast.show(copy.keepingRoomOpen)
        }
      }
    },
    [closeWith, toast],
  )

  const roomState = useRoomState({ roomId, enabled: session.status === 'ready', onDeltas })
  const room = roomState.room
  const me: RoomParticipantDto | null = room?.myParticipant ?? null
  useEffect(() => {
    if (me !== null) myIdRef.current = me.id
  }, [me])
  useRoomPresence(roomId, media.status === 'connected')

  // Humans enter as viewers (spec §59 "Default: viewer"), then connect subscribe-only.
  useEffect(() => {
    if (!isHuman || room === null || closed !== null || joinAttempted.current) return
    if (room.status === 'ended') return
    joinAttempted.current = true
    const enter = async () => {
      let current = room
      if (current.myParticipant === null || current.myParticipant.status !== 'active') {
        try {
          current = await earth.rooms.join({
            roomId,
            mediaState: 'watching',
            consentLevel: VIEWER_CONSENT_LEVEL,
          })
          roomState.setRoom(current)
        } catch (cause) {
          setClosed(closedKindForError(errorCode(cause)))
          return
        }
      }
      const mine = current.myParticipant
      const groupId = groupIdOf(current)
      joinedAt.current = Date.now()
      analytics.track('room_joined', {
        roomId,
        mediaState: mine?.mediaState ?? 'watching',
        role: mine?.role ?? 'viewer',
        contextType: current.contextType,
        ...(groupId === undefined ? {} : { groupId }),
        participantCount: current.participants.filter((p) => p.status === 'active').length,
      })
      const connected = await media.connect(roomId)
      // After a reload the server still has us on audio/camera: publish again.
      if (connected && mine !== null && mine.mediaState !== 'watching') {
        await media.setMicrophone(true)
        if (mine.mediaState === 'camera') await media.setCamera(true)
      }
    }
    void enter()
  }, [isHuman, room, closed, earth, roomId, roomState, analytics, media])

  const showConsent = useCallback((prompt: ConsentPrompt) => setConsentPrompt(prompt), [])

  // A pending Open up that this publisher has to answer (ARCHITECTURE §10) is derived from the
  // room state; a join-time prompt takes precedence while it is open.
  const pendingLevel = room === null ? null : pendingConsentFor(room, me)
  const widenPrompt: ConsentPrompt | null =
    pendingLevel !== null && pendingLevel !== answeredPending && consentPrompt === null
      ? { trigger: 'widen', level: pendingLevel, mediaState: null }
      : null
  const activeConsent: ConsentPrompt | null = consentPrompt ?? widenPrompt
  useEffect(() => {
    if (activeConsent === null) return
    const key = `${activeConsent.trigger}:${activeConsent.level}`
    if (shownConsent.current.has(key)) return
    shownConsent.current.add(key)
    analytics.track('participant_consent_shown', {
      roomId,
      level: activeConsent.level,
      trigger: activeConsent.trigger,
    })
  }, [activeConsent, analytics, roomId])

  const applyMedia = useCallback(
    async (mediaState: JoinMediaState, level: RoomVisibility) => {
      const previous: MediaState = me?.mediaState ?? 'watching'
      setBusy(true)
      setNotice(null)
      try {
        await earth.rooms.setMediaState({ roomId, mediaState, consentLevel: level })
        await roomState.refresh()
        if (previous === 'watching') {
          const connected = await media.reconnect(roomId)
          if (!connected) return
        }
        const mic = await media.setMicrophone(true)
        if (!mic.ok)
          setNotice(
            mic.kind === 'media_permission_denied'
              ? roomCopy.micPermission
              : roomCopy.couldntChange,
          )
        if (mediaState === 'camera') {
          const cam = await media.setCamera(true)
          if (!cam.ok) {
            setNotice(
              cam.kind === 'media_permission_denied'
                ? roomCopy.cameraPermission
                : roomCopy.couldntChange,
            )
            await earth.rooms.setMediaState({ roomId, mediaState: 'audio' }).catch(() => undefined)
            await roomState.refresh()
          } else if (previous !== 'camera') {
            analytics.track('camera_enabled', { roomId, previousMediaState: previous })
          }
        }
        if (previous === 'watching')
          analytics.track('audio_joined', { roomId, previousMediaState: previous })
      } catch (cause) {
        const code = errorCode(cause)
        if (code === 'consent_required') showConsent({ trigger: 'join', level, mediaState })
        else
          setNotice(
            code === 'join_not_allowed' || code === 'not_visible'
              ? roomCopy.joinNotAllowed
              : roomCopy.couldntChange,
          )
      } finally {
        setBusy(false)
      }
    },
    [earth, roomId, me, media, roomState, analytics, showConsent],
  )

  const requestMedia = useCallback(
    (mediaState: JoinMediaState) => {
      if (room === null) return
      analytics.track('live_join_requested', { roomId, mediaState, source: 'card' })
      const decision = consentDecision({
        room,
        myConsentLevel: me?.audienceConsentLevel ?? null,
        mediaState,
      })
      if (decision.showSheet) {
        showConsent({ trigger: 'join', level: decision.level, mediaState })
        return
      }
      void applyMedia(mediaState, decision.level)
    },
    [room, analytics, roomId, me, showConsent, applyMedia],
  )

  const onConsentChoice = useCallback(
    async (mediaState: MediaState) => {
      const prompt = activeConsent
      if (prompt === null) return
      setConsentPrompt(null)
      if (prompt.trigger === 'join') {
        if (mediaState === 'watching') return
        analytics.track('participant_consent_accepted', {
          roomId,
          level: prompt.level,
          trigger: 'join',
        })
        await applyMedia(mediaState, prompt.level)
        return
      }
      setAnsweredPending(prompt.level)
      setBusy(true)
      try {
        if (mediaState === 'watching') {
          await earth.rooms.setMediaState({ roomId, mediaState: 'watching' })
          await media.setCamera(false)
          await media.setMicrophone(false)
        } else {
          analytics.track('participant_consent_accepted', {
            roomId,
            level: prompt.level,
            trigger: 'widen',
          })
          await earth.rooms.consent({ roomId, level: prompt.level })
          if (mediaState === 'audio' && me?.mediaState === 'camera') {
            await earth.rooms.setMediaState({
              roomId,
              mediaState: 'audio',
              consentLevel: prompt.level,
            })
            await media.setCamera(false)
          }
        }
        await roomState.refresh()
      } catch {
        setNotice(roomCopy.couldntChange)
      } finally {
        setBusy(false)
      }
    },
    [activeConsent, analytics, roomId, applyMedia, earth, media, me, roomState],
  )

  const leave = useCallback(async () => {
    trackLeft('left')
    await media.disconnect()
    if (isHuman) await earth.rooms.leave(roomId).catch(() => undefined)
    router.push(TAB_ROUTES.live)
  }, [trackLeft, media, isHuman, earth, roomId, router])

  const toggleMic = useCallback(() => {
    void media.setMicrophone(!media.micEnabled).then((result) => {
      if (!result.ok && result.kind === 'media_permission_denied') setNotice(roomCopy.micPermission)
    })
  }, [media])

  const toggleCamera = useCallback(() => {
    if (media.cameraEnabled) {
      void (async () => {
        await media.setCamera(false)
        await earth.rooms.setMediaState({ roomId, mediaState: 'audio' }).catch(() => undefined)
        await roomState.refresh()
      })()
      return
    }
    requestMedia('camera')
  }, [media, earth, roomId, roomState, requestMedia])

  const openUp = useCallback(
    async (visibility: RoomVisibility, joinPolicy: RoomJoinPolicy) => {
      if (room === null) return
      setBusy(true)
      setOpenUpError(null)
      try {
        const result = await earth.rooms.setVisibility({ roomId, visibility, joinPolicy })
        analytics.track('room_visibility_changed', {
          roomId,
          from: room.visibility,
          to: visibility,
          joinPolicy,
          applied: result.applied,
        })
        await roomState.refresh()
        if (result.applied) setSheet('none')
      } catch {
        setOpenUpError(roomCopy.couldntChange)
      } finally {
        setBusy(false)
      }
    },
    [room, earth, roomId, analytics, roomState],
  )

  const share = useCallback(async () => {
    setBusy(true)
    try {
      const invite = await earth.rooms.invites.create({ roomId })
      try {
        await navigator.clipboard.writeText(invite.url)
        toast.show(roomCopy.linkCopied)
        setShareUrl(null)
      } catch {
        setShareUrl(invite.url)
      }
    } catch {
      toast.show(webCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }, [earth, roomId, toast])

  const toggleGuests = useCallback(async () => {
    if (room === null) return
    setBusy(true)
    try {
      await earth.rooms.setGuestsDisabled({ roomId, disabled: !room.guestsDisabled })
      await roomState.refresh()
    } catch {
      toast.show(webCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }, [room, earth, roomId, roomState, toast])

  const endRoom = useCallback(async () => {
    setBusy(true)
    try {
      await earth.rooms.end({ roomId })
      setSheet('none')
      await closeWith('ended', 'ended')
    } catch {
      toast.show(webCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }, [earth, roomId, closeWith, toast])

  // Spec §81: the room itself, or one person in it — the participants sheet sets the target.
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

  const removeParticipant = useCallback(
    async (participant: RoomParticipantDto, blockFromRoom: boolean) => {
      setBusyParticipant(participant.id)
      try {
        await earth.rooms.removeParticipant({
          roomId,
          participantId: participant.id,
          blockFromRoom,
        })
        if (participant.isGuest && participant.guestSessionId !== null) {
          analytics.track('guest_removed', { roomId, guestSessionId: participant.guestSessionId })
        } else {
          analytics.track('room_participant_removed', { roomId, removedRole: participant.role })
        }
        await roomState.refresh()
      } catch {
        toast.show(webCopy.somethingWrong)
      } finally {
        setBusyParticipant(null)
      }
    },
    [earth, roomId, analytics, roomState, toast],
  )

  const admit = useCallback(
    async (participant: RoomParticipantDto) => {
      setBusyParticipant(participant.id)
      try {
        await earth.rooms.admit({ roomId, participantId: participant.id })
        await roomState.refresh()
      } catch {
        toast.show(webCopy.somethingWrong)
      } finally {
        setBusyParticipant(null)
      }
    },
    [earth, roomId, roomState, toast],
  )

  // ------------------------------------------------------------------ render
  if (session.status === 'loading' || (roomState.loading && room === null)) return <LoadingRoom />

  const effectiveClosed = closed ?? (room?.status === 'ended' ? 'ended' : null)
  if (effectiveClosed !== null) {
    return <RoomEnded kind={effectiveClosed} backHref={TAB_ROUTES.live} />
  }
  if (room === null) {
    const kind = roomState.error === null ? 'error' : closedKindForError(roomState.error)
    if (!isHuman && kind !== 'not_visible') {
      // A Visitor cannot read a room they are not eligible for: the claim sheet is the answer.
      return (
        <div className="flex h-dvh flex-col bg-background">
          <RoomEnded kind="not_visible" backHref={TAB_ROUTES.live} />
          <ViewerJoin onJoin={() => undefined} onTap={() => gate.requireHuman('public_world')} />
        </div>
      )
    }
    return (
      <RoomEnded kind={kind} backHref={TAB_ROUTES.live} onRetry={() => void roomState.refresh()} />
    )
  }

  const publishing = me !== null && me.status === 'active' && me.mediaState !== 'watching'
  const mode = !isHuman ? 'visitor' : publishing ? 'participant' : 'viewer'
  const moderator = canModerate(me)
  const groupId = groupIdOf(room)

  return (
    <RoomView
      room={room}
      media={isHuman ? media : null}
      mode={mode}
      canOpenUp={moderator}
      busy={busy}
      notice={notice}
      headerTrailing={
        groupId !== undefined && isHuman ? (
          <button
            type="button"
            aria-label={roomCopy.groupChat}
            onClick={() => setSheet('chat')}
            className="flex size-touch-target items-center justify-center rounded-avatar text-text-primary hover:bg-subtle-fill"
          >
            <Icon name="chats" />
          </button>
        ) : undefined
      }
      joinBar={
        mode === 'participant' ? undefined : (
          <ViewerJoin
            onJoin={requestMedia}
            onTap={isHuman ? undefined : () => gate.requireHuman('public_world')}
            busy={busy}
            error={null}
          />
        )
      }
      onMic={toggleMic}
      onCamera={toggleCamera}
      onFlip={() => void media.flipCamera()}
      onParticipants={() => setSheet('participants')}
      onOpenUp={() => {
        setOpenUpError(null)
        setSheet('openUp')
      }}
      onMore={() => setSheet('more')}
      onLeave={() => void leave()}
      onRetry={() => void media.retry()}
    >
      {activeConsent !== null ? (
        <ConsentSheet
          open
          initiatorName={initiatorName(room)}
          level={activeConsent.level}
          busy={busy}
          onChoose={(choice) => void onConsentChoice(choice)}
          onClose={() => void onConsentChoice('watching')}
        />
      ) : null}
      <ParticipantsSheet
        open={sheet === 'participants'}
        participants={room.participants}
        meId={me?.id ?? null}
        canModerate={moderator}
        busyId={busyParticipant}
        onRemove={(participant, block) => void removeParticipant(participant, block)}
        onAdmit={(participant) => void admit(participant)}
        onReport={reportParticipant}
        onClose={() => setSheet('none')}
      />
      {moderator ? (
        <OpenUpSheet
          open={sheet === 'openUp'}
          room={room}
          flags={flags}
          busy={busy}
          error={openUpError}
          onApply={(visibility, joinPolicy) => void openUp(visibility, joinPolicy)}
          onClose={() => setSheet('none')}
        />
      ) : null}
      <MoreSheet
        open={sheet === 'more'}
        canModerate={moderator}
        // Only a Human shares a room link or moderates it (SCREEN 18, §43): the controls already
        // hide this sheet from Visitors and Guests, and the sheet refuses it a second time.
        isGuest={!isHuman}
        guestsDisabled={room.guestsDisabled}
        shareUrl={shareUrl}
        busy={busy}
        onShare={() => void share()}
        onToggleGuests={() => void toggleGuests()}
        onEnd={() => void endRoom()}
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
      {groupId !== undefined ? (
        <GroupChatDrawer
          open={sheet === 'chat'}
          groupId={groupId}
          title={room.contextTitle ?? roomCopy.groupChat}
          onClose={() => setSheet('none')}
        />
      ) : null}
    </RoomView>
  )
}
