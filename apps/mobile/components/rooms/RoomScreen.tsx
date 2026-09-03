/**
 * SCREEN 14 — the Active Room for Humans and Visitors at `/rooms/[id]` (spec §57–§62, §109;
 * ARCHITECTURE §8, §10). A Human opens the room as a viewer (`room_join` watching → token →
 * subscribe-only LiveKit), then "Join them" → audio / camera through the consent rules; the room
 * state follows `subscribeRoom` and the stage follows the room reducer. Visitors see faces and
 * names and meet the claim sheet when they try to act (spec §43). Guests join from the web
 * (`/live/[token]`). The screen stays awake while it is open.
 */
import '@/features/rooms/livekit'

import type { ConsentTrigger } from '@earth/analytics'
import { FeatureFlag } from '@earth/config'
import {
  type GroupId,
  type MediaState,
  type ReportReason,
  type RoomDto,
  type RoomId,
  type RoomJoinPolicy,
  type RoomParticipantDto,
  type RoomVisibility,
  asGroupId,
} from '@earth/domain'
import type { RoomStateDelta } from '@earth/realtime'
import { colors, copy, space, spacing } from '@earth/ui'
import { Camera } from 'expo-camera'
import { useKeepAwake } from 'expo-keep-awake'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Share, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { Spinner } from '@/components/ui/Spinner'
import { StatusLine } from '@/components/ui/StatusLine'
import { roomCopy } from '@/features/rooms/copy'
import { useMediaConnection } from '@/features/rooms/hooks/useMediaConnection'
import { useRoomPresence } from '@/features/rooms/hooks/useRoomPresence'
import { useRoomState } from '@/features/rooms/hooks/useRoomState'
import { useRoomTiles } from '@/features/rooms/hooks/useRoomTiles'
import { LIVE_ROUTE } from '@/features/rooms/routes'
import { useRoomShell } from '@/features/rooms/shell'
import { type RoomClosedKind, closedKindForError } from '@/features/rooms/state/closed'
import {
  VIEWER_CONSENT_LEVEL,
  becameModerator,
  canModerate,
  consentDecision,
  initiatorName,
  pendingConsentFor,
} from '@/features/rooms/state/consent'
import { errorCode } from '@/lib/errors'
import { lightTap } from '@/lib/haptics'

import { ConsentSheet } from './ConsentSheet'
import { GroupChatDrawer } from './GroupChatDrawer'
import { MoreSheet } from './MoreSheet'
import { OpenUpSheet } from './OpenUpSheet'
import { ParticipantsSheet } from './ParticipantsSheet'
import { ReportSheet } from './ReportSheet'
import { RoomEnded } from './RoomEnded'
import { RoomView } from './RoomView'
import { type JoinMediaState, ViewerJoin } from './ViewerJoin'

export interface RoomScreenProps {
  readonly roomId: RoomId
}

type SheetKind = 'none' | 'participants' | 'openUp' | 'more' | 'report' | 'chat'

interface ConsentPrompt {
  readonly trigger: ConsentTrigger
  readonly level: RoomVisibility
  /** What the person asked for when the sheet opened (join trigger); `null` for a widening. */
  readonly mediaState: JoinMediaState | null
}

/** One keep-awake lock for the room; released when the screen unmounts. */
const KEEP_AWAKE_TAG = 'earth:room'

function groupIdOf(room: Pick<RoomDto, 'contextType' | 'contextId'>): GroupId | undefined {
  return room.contextType === 'group' && room.contextId !== null
    ? asGroupId(room.contextId)
    : undefined
}

/** The OS prompts for the microphone (and camera) before the SDK publishes; a refusal is reported. */
async function ensureMediaPermissions(
  mediaState: JoinMediaState,
): Promise<'ok' | 'microphone' | 'camera'> {
  try {
    const mic = await Camera.requestMicrophonePermissionsAsync()
    if (!mic.granted) return 'microphone'
    if (mediaState === 'camera') {
      const camera = await Camera.requestCameraPermissionsAsync()
      if (!camera.granted) return 'camera'
    }
  } catch {
    // Without the module (a web preview) the SDK's own errors decide.
  }
  return 'ok'
}

/**
 * Before the room state arrives. The room route disables the back gesture, so a way out is always
 * on screen; offline, the line says so instead of spinning silently (spec §107).
 */
function LoadingRoom({
  online,
  onBack,
}: {
  readonly online: boolean
  readonly onBack: () => void
}) {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.loading, { paddingBottom: insets.bottom + space[6] }]}>
      {online ? (
        <Spinner fill label={roomCopy.connecting} />
      ) : (
        <View style={styles.offline}>
          <StatusLine banner message={copy.connectionUnavailable} />
        </View>
      )}
      <View style={styles.loadingActions}>
        <Button variant="quiet" label={roomCopy.backToLive} onPress={onBack} />
      </View>
    </View>
  )
}

export function RoomScreen({ roomId }: RoomScreenProps) {
  const { earth, sessionStatus, isHuman, flags, track, requireHuman, toast, online } =
    useRoomShell()
  const router = useRouter()
  const media = useMediaConnection()
  const tilesStore = useRoomTiles()
  useKeepAwake(KEEP_AWAKE_TAG)

  const [closed, setClosed] = useState<RoomClosedKind | null>(null)
  const [sheet, setSheet] = useState<SheetKind>('none')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [consentPrompt, setConsentPrompt] = useState<ConsentPrompt | null>(null)
  const [answeredPending, setAnsweredPending] = useState<RoomVisibility | null>(null)
  const [openUpError, setOpenUpError] = useState<string | null>(null)
  const [reportDone, setReportDone] = useState(false)
  const [busyParticipant, setBusyParticipant] = useState<string | null>(null)

  const joinedAt = useRef<number | null>(null)
  const joinAttempted = useRef(false)
  const leftTracked = useRef(false)
  const myIdRef = useRef<string | null>(null)
  const shownConsent = useRef<Set<string>>(new Set())

  const backToLive = useCallback(() => {
    if (router.canGoBack()) router.back()
    else router.replace(LIVE_ROUTE)
  }, [router])

  const trackLeft = useCallback(
    (reason: 'left' | 'ended' | 'removed') => {
      if (leftTracked.current || joinedAt.current === null) return
      leftTracked.current = true
      track('room_left', { roomId, durationMs: Date.now() - joinedAt.current, reason })
    },
    [track, roomId],
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
      tilesStore.applyDeltas(deltas, meId)
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
          toast(copy.keepingRoomOpen)
        }
      }
    },
    [tilesStore, closeWith, toast],
  )

  const roomState = useRoomState({ roomId, enabled: sessionStatus === 'ready', onDeltas })
  const room = roomState.room
  const me: RoomParticipantDto | null = room?.myParticipant ?? null
  useEffect(() => {
    if (me !== null) myIdRef.current = me.id
  }, [me])
  useRoomPresence(roomId, media.status === 'connected')
  // Participants → stage tiles (stable order); the reducer is reconciled with every snapshot.
  const tiles = tilesStore.reconcile(room, me?.id ?? null)

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
      track('room_joined', {
        roomId,
        mediaState: mine?.mediaState ?? 'watching',
        role: mine?.role ?? 'viewer',
        contextType: current.contextType,
        ...(groupId === undefined ? {} : { groupId }),
        participantCount: current.participants.filter((p) => p.status === 'active').length,
      })
      const connected = await media.connect(roomId)
      // After a relaunch the server still has us on audio/camera: publish again.
      if (connected && mine !== null && mine.mediaState !== 'watching') {
        await media.setMicrophone(true)
        if (mine.mediaState === 'camera') await media.setCamera(true)
      }
    }
    void enter()
  }, [isHuman, room, closed, earth, roomId, roomState, track, media])

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
    track('participant_consent_shown', {
      roomId,
      level: activeConsent.level,
      trigger: activeConsent.trigger,
    })
  }, [activeConsent, track, roomId])

  const applyMedia = useCallback(
    async (mediaState: JoinMediaState, level: RoomVisibility) => {
      const previous: MediaState = me?.mediaState ?? 'watching'
      setBusy(true)
      setNotice(null)
      try {
        const permission = await ensureMediaPermissions(mediaState)
        if (permission !== 'ok') {
          setNotice(
            permission === 'microphone' ? roomCopy.micPermission : roomCopy.cameraPermission,
          )
          return
        }
        await earth.rooms.setMediaState({ roomId, mediaState, consentLevel: level })
        await roomState.refresh()
        if (previous === 'watching') {
          const connected = await media.reconnect(roomId)
          if (!connected) return
        }
        const mic = await media.setMicrophone(true)
        if (!mic.ok) {
          setNotice(
            mic.kind === 'media_permission_denied'
              ? roomCopy.micPermission
              : roomCopy.couldntChange,
          )
        }
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
            track('camera_enabled', { roomId, previousMediaState: previous })
          }
        }
        if (previous === 'watching') track('audio_joined', { roomId, previousMediaState: previous })
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
    [earth, roomId, me, media, roomState, track, showConsent],
  )

  const requestMedia = useCallback(
    (mediaState: JoinMediaState) => {
      if (room === null) return
      lightTap()
      track('live_join_requested', { roomId, mediaState, source: 'card' })
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
    [room, track, roomId, me, showConsent, applyMedia],
  )

  const onConsentChoice = useCallback(
    async (mediaState: MediaState) => {
      const prompt = activeConsent
      if (prompt === null) return
      setConsentPrompt(null)
      if (prompt.trigger === 'join') {
        if (mediaState === 'watching') return
        lightTap()
        track('participant_consent_accepted', { roomId, level: prompt.level, trigger: 'join' })
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
          lightTap()
          track('participant_consent_accepted', { roomId, level: prompt.level, trigger: 'widen' })
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
    [activeConsent, track, roomId, applyMedia, earth, media, me, roomState],
  )

  const leave = useCallback(async () => {
    lightTap()
    trackLeft('left')
    await media.disconnect()
    if (isHuman) await earth.rooms.leave(roomId).catch(() => undefined)
    backToLive()
  }, [trackLeft, media, isHuman, earth, roomId, backToLive])

  const toggleMic = useCallback(() => {
    lightTap()
    void media.setMicrophone(!media.micEnabled).then((result) => {
      if (!result.ok && result.kind === 'media_permission_denied') setNotice(roomCopy.micPermission)
    })
  }, [media])

  const toggleCamera = useCallback(() => {
    lightTap()
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
      lightTap()
      setBusy(true)
      setOpenUpError(null)
      try {
        const result = await earth.rooms.setVisibility({ roomId, visibility, joinPolicy })
        track('room_visibility_changed', {
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
    [room, earth, roomId, track, roomState],
  )

  const share = useCallback(async () => {
    lightTap()
    setBusy(true)
    try {
      const invite = await earth.rooms.invites.create({ roomId })
      setSheet('none')
      await Share.share({ message: invite.url, url: invite.url })
    } catch {
      toast(roomCopy.somethingWrong)
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
      toast(roomCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }, [room, earth, roomId, roomState, toast])

  const endRoom = useCallback(async () => {
    lightTap()
    setBusy(true)
    try {
      await earth.rooms.end({ roomId })
      setSheet('none')
      await closeWith('ended', 'ended')
    } catch {
      toast(roomCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }, [earth, roomId, closeWith, toast])

  const report = useCallback(
    async (reason: ReportReason) => {
      setBusy(true)
      try {
        await earth.safety.report({ targetType: 'room', targetId: roomId, reason, details: null })
        track('content_reported', { targetType: 'room', reason })
        setReportDone(true)
      } catch {
        toast(roomCopy.somethingWrong)
      } finally {
        setBusy(false)
      }
    },
    [earth, roomId, track, toast],
  )

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
          track('guest_removed', { roomId, guestSessionId: participant.guestSessionId })
        } else {
          track('room_participant_removed', { roomId, removedRole: participant.role })
        }
        await roomState.refresh()
      } catch {
        toast(roomCopy.somethingWrong)
      } finally {
        setBusyParticipant(null)
      }
    },
    [earth, roomId, track, roomState, toast],
  )

  const admit = useCallback(
    async (participant: RoomParticipantDto) => {
      setBusyParticipant(participant.id)
      try {
        await earth.rooms.admit({ roomId, participantId: participant.id })
        await roomState.refresh()
      } catch {
        toast(roomCopy.somethingWrong)
      } finally {
        setBusyParticipant(null)
      }
    },
    [earth, roomId, roomState, toast],
  )

  // ------------------------------------------------------------------ render
  if (sessionStatus === 'loading' || (roomState.loading && room === null)) {
    return <LoadingRoom online={online} onBack={backToLive} />
  }

  const effectiveClosed = closed ?? (room?.status === 'ended' ? 'ended' : null)
  if (effectiveClosed !== null) {
    return <RoomEnded kind={effectiveClosed} onBack={backToLive} />
  }
  if (room === null) {
    const kind = roomState.error === null ? 'error' : closedKindForError(roomState.error)
    if (!isHuman && kind !== 'not_visible') {
      // A Visitor cannot read a room they are not eligible for: the claim sheet is the answer.
      return (
        <View style={styles.loading}>
          <RoomEnded kind="not_visible" onBack={backToLive} />
          <ViewerJoin onJoin={() => undefined} onTap={() => requireHuman('public_world')} />
        </View>
      )
    }
    return <RoomEnded kind={kind} onBack={backToLive} onRetry={() => void roomState.refresh()} />
  }

  const publishing = me !== null && me.status === 'active' && me.mediaState !== 'watching'
  const mode = !isHuman ? 'visitor' : publishing ? 'participant' : 'viewer'
  const moderator = canModerate(me)
  const groupId = groupIdOf(room)

  return (
    <RoomView
      room={room}
      tiles={tiles}
      media={isHuman ? media : null}
      mode={mode}
      canOpenUp={moderator}
      busy={busy}
      notice={notice}
      headerTrailing={
        groupId !== undefined && isHuman ? (
          <IconButton name="chats" label={roomCopy.groupChat} onPress={() => setSheet('chat')} />
        ) : undefined
      }
      joinBar={
        mode === 'participant' ? undefined : (
          <ViewerJoin
            onJoin={requestMedia}
            onTap={isHuman ? undefined : () => requireHuman('public_world')}
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
        guestsDisabled={room.guestsDisabled}
        guestsEnabled={flags[FeatureFlag.GUEST_ROOMS_ENABLED]}
        busy={busy}
        onShare={() => void share()}
        onToggleGuests={() => void toggleGuests()}
        onEnd={() => void endRoom()}
        onReport={() => {
          setReportDone(false)
          setSheet('report')
        }}
        onLeave={() => void leave()}
        onClose={() => setSheet('none')}
      />
      <ReportSheet
        open={sheet === 'report'}
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

const styles = StyleSheet.create({
  loading: { flex: 1, backgroundColor: colors.background },
  offline: { flex: 1, justifyContent: 'center' },
  loadingActions: { alignItems: 'center', paddingHorizontal: spacing.screenMargin },
})
