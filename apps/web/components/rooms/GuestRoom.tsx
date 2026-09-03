'use client'

/**
 * SCREEN 17 → 19 — the Guest web at `/live/[token]` (spec §34, §112; the critical acquisition
 * surface). The preview is server-rendered by the page; this component owns the flow: "Join as
 * Guest" → "Your name" (+ optional camera preview) → "Join" → anonymous credential → guest
 * session → the room → the small optional post-room screen. Signed-in Humans see "Join them".
 * Target: link tap to conversation in under 15 s — the credential is minted while the person
 * types their name, the room chunk is prefetched, and no step is added.
 */
import type { GuestOutcome, ViewerRoleKind } from '@earth/analytics'
import { type AuthSessionLike, isAnonymousSession } from '@earth/auth'
import { FeatureFlag } from '@earth/config'
import { type RoomInvitePreviewDto } from '@earth/domain'
import { copy, liveTitle } from '@earth/ui'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import { markClaimTracked } from '../../lib/claim/tracking'
import { webCopy } from '../../lib/copy'
import { errorCode } from '../../lib/errors'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useFlags } from '../../lib/providers/FlagsProvider'
import { useEarth, useRuntime } from '../../lib/providers/RuntimeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { ROUTES, asRoute } from '../../lib/routes'
import { sessionStore } from '../../lib/storage'
import { useClaimGate } from '../shell/ClaimSheet'
import { Button } from '../ui/Button'
import { FaceStack } from '../ui/FaceStack'
import { LiveMark } from '../ui/LiveMark'
import { Spinner } from '../ui/Spinner'
import { GuestNameStep } from './GuestNameStep'
import { GuestPostRoom } from './GuestPostRoom'
import { roomCopy } from './copy'
import { useDeviceFingerprint } from './hooks/useDeviceFingerprint'
import { useIsMobileUa } from './hooks/useIsMobileUa'
import { appRoomLink, claimFromGuestRoomRoute, roomRoute } from './routes'
import {
  INITIAL_GUEST_FLOW,
  guestDurationMs,
  guestFlowReducer,
  guestJoinMediaState,
  normalizeGuestName,
} from './state/guestFlow'
import { rememberGuestSession } from './state/guestStorage'

const GuestInRoom = dynamic(() => import('./GuestInRoom').then((m) => m.GuestInRoom), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center bg-background">
      <Spinner label={roomCopy.joiningRoom} />
    </div>
  ),
})

/** Warms the room chunk so "Join" opens the stage without a second download. */
function prefetchRoomChunk(): void {
  void import('./GuestInRoom')
}

export interface GuestRoomProps {
  readonly token: string
  readonly preview: RoomInvitePreviewDto
}

export function previewTitle(preview: RoomInvitePreviewDto): string {
  if (preview.contextTitle !== null) return preview.contextTitle
  const names = preview.participants.map((p) => p.displayName)
  const title = liveTitle(names, preview.participants.length)
  return title === '' ? roomCopy.liveTitle : title
}

function viewerState(roleKind: string): ViewerRoleKind {
  return roleKind === 'human' || roleKind === 'guest' || roleKind === 'claiming'
    ? roleKind
    : 'visitor'
}

function isSignedInPerson(session: AuthSessionLike | null): boolean {
  return session !== null && !isAnonymousSession(session)
}

export function GuestRoom({ token, preview }: GuestRoomProps) {
  const { runtime } = useRuntime()
  const earth = useEarth()
  const session = useSession()
  const flags = useFlags()
  const analytics = useAnalytics()
  const gate = useClaimGate()
  const router = useRouter()
  const isMobile = useIsMobileUa()
  const fingerprint = useDeviceFingerprint()
  const [state, dispatch] = useReducer(guestFlowReducer, INITIAL_GUEST_FLOW)
  const [humanBusy, setHumanBusy] = useState(false)
  const [humanError, setHumanError] = useState<string | null>(null)
  const credential = useRef<Promise<AuthSessionLike> | null>(null)
  const opened = useRef(false)

  const signedIn = isSignedInPerson(session.session)
  const guestsOk = flags[FeatureFlag.GUEST_ROOMS_ENABLED] && preview.guestsAllowed && !preview.ended

  useEffect(() => {
    if (session.status !== 'ready' || opened.current) return
    opened.current = true
    analytics.track('guest_room_opened', {
      roomId: preview.roomId,
      viewerState: viewerState(session.roleKind),
    })
  }, [session.status, session.roleKind, analytics, preview.roomId])

  const warmCredential = useCallback(() => {
    if (runtime === null || signedIn || session.roleKind === 'guest') return
    credential.current ??= runtime.session.signInAnonymously().catch((cause: unknown) => {
      credential.current = null
      throw cause
    })
  }, [runtime, signedIn, session.roleKind])

  const start = () => {
    dispatch({ type: 'start' })
    prefetchRoomChunk()
    warmCredential()
  }

  const join = useCallback(
    async (name: string, wantsCamera: boolean) => {
      const mediaState = guestJoinMediaState({ wantsCamera })
      try {
        if (runtime !== null && !signedIn && session.session === null) {
          warmCredential()
          if (credential.current !== null) await credential.current
        }
        const hash = await fingerprint()
        const created = await earth.guest.createSession({
          inviteToken: token,
          displayName: name,
          deviceFingerprintHash: hash,
          mediaState,
        })
        analytics.track('guest_joined', {
          roomId: created.roomId,
          guestSessionId: created.guestSessionId,
          mediaState,
        })
        dispatch({
          type: 'joined',
          guestSessionId: created.guestSessionId,
          roomId: created.roomId,
          at: Date.now(),
        })
      } catch (cause) {
        const code = errorCode(cause)
        dispatch({
          type: 'join_failed',
          error:
            code === 'guests_disabled' || code === 'guest_not_allowed'
              ? 'guests_disabled'
              : code === 'invite_invalid' || code === 'invite_expired' || code === 'room_ended'
                ? 'link_unusable'
                : 'join_failed',
        })
      }
    },
    [runtime, signedIn, session.session, warmCredential, fingerprint, earth, token, analytics],
  )

  const submit = () => {
    const name = normalizeGuestName(state.name)
    dispatch({ type: 'submit' })
    if (name !== null && state.step === 'name') void join(name, state.wantsCamera)
  }

  const onLeft = useCallback(
    (outcome: GuestOutcome) => {
      if (state.guestSessionId !== null && state.roomId !== null) {
        analytics.track('guest_room_completed', {
          roomId: state.roomId,
          guestSessionId: state.guestSessionId,
          durationMs: guestDurationMs(state, Date.now()),
          outcome,
        })
        rememberGuestSession(sessionStore(), {
          guestSessionId: state.guestSessionId,
          roomId: state.roomId,
          leftAt: Date.now(),
        })
      }
      dispatch({ type: 'left', outcome })
    },
    [state, analytics],
  )

  const joinAsHuman = async () => {
    setHumanBusy(true)
    setHumanError(null)
    try {
      const room = await earth.rooms.joinWithInvite({
        token,
        mediaState: 'watching',
        consentLevel: 'invited',
      })
      analytics.track('live_join_requested', {
        roomId: room.id,
        mediaState: 'watching',
        source: 'invite',
      })
      router.push(roomRoute(room.id))
    } catch (cause) {
      const code = errorCode(cause)
      setHumanError(
        code === 'invite_expired' || code === 'invite_invalid' || code === 'room_ended'
          ? roomCopy.linkNotUsable
          : webCopy.somethingWrong,
      )
      setHumanBusy(false)
    }
  }

  const claim = () => {
    analytics.track('claim_started', { entry: 'guest_room', hasGroupInvite: false })
    markClaimTracked()
    dispatch({ type: 'finish' })
    router.push(claimFromGuestRoomRoute())
  }

  // ------------------------------------------------------------------ render
  if (state.step === 'in_room' && state.roomId !== null) {
    return (
      <GuestInRoom
        token={token}
        roomId={state.roomId}
        wantsCamera={state.wantsCamera}
        onLeft={onLeft}
      />
    )
  }
  if (state.step === 'post_room' || state.step === 'done') {
    return <GuestPostRoom onClaim={claim} onDone={() => router.push(asRoute(ROUTES.home))} />
  }

  const names = preview.participants.map((p) => p.displayName)
  const finalError =
    state.error === 'guests_disabled'
      ? roomCopy.guestsNotAllowed
      : state.error === 'link_unusable'
        ? roomCopy.linkNotUsable
        : null

  return (
    <section className="fade-in flex flex-1 flex-col gap-6 py-6">
      <div className="flex flex-col gap-4">
        {preview.participants.length > 0 ? (
          <FaceStack people={preview.participants} size="large" label={names.join(', ')} />
        ) : null}
        <div className="flex flex-col gap-1">
          <h1 className="text-title">{previewTitle(preview)}</h1>
          <p className="flex flex-wrap items-center gap-2 text-secondary text-text-secondary">
            {preview.ended ? <span>{roomCopy.roomEnded}</span> : <LiveMark />}
            {preview.invitedByDisplayName !== null ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{roomCopy.invitedBy(preview.invitedByDisplayName)}</span>
              </>
            ) : null}
            <span aria-hidden="true">·</span>
            <span>{roomCopy.joinPolicyLine(copy.joinPolicies[preview.joinPolicy])}</span>
          </p>
        </div>
      </div>

      {preview.ended ? null : signedIn ? (
        <div className="flex flex-col gap-3">
          <Button
            variant="primary"
            fullWidth
            loading={humanBusy || session.status === 'loading'}
            onClick={() => void joinAsHuman()}
          >
            {copy.joinThem}
          </Button>
          {humanError !== null ? (
            <p role="alert" className="text-secondary text-danger">
              {humanError}
            </p>
          ) : null}
        </div>
      ) : state.step === 'preview' ? (
        <div className="flex flex-col gap-3">
          {guestsOk && finalError === null ? (
            <Button
              variant="primary"
              fullWidth
              loading={session.status === 'loading'}
              onClick={start}
            >
              {copy.joinAsGuest}
            </Button>
          ) : (
            <>
              <p className="text-body text-text-secondary">
                {finalError ?? roomCopy.guestsNotAllowed}
              </p>
              <Button variant="primary" fullWidth onClick={() => gate.open('room_invite')}>
                {copy.claimYourPlace}
              </Button>
            </>
          )}
          {guestsOk && finalError === null ? (
            <Button variant="quiet" fullWidth onClick={() => gate.open('room_invite')}>
              {copy.claimYourPlace}
            </Button>
          ) : null}
        </div>
      ) : (
        <GuestNameStep
          name={state.name}
          wantsCamera={state.wantsCamera}
          joining={state.step === 'joining'}
          error={state.error}
          onName={(name) => dispatch({ type: 'name_changed', name })}
          onCamera={(on) => dispatch({ type: 'camera_toggled', on })}
          onSubmit={submit}
        />
      )}

      {isMobile && !preview.ended ? (
        <a
          href={appRoomLink(token)}
          className="min-h-touch-target inline-flex items-center self-start text-body text-earth-accent"
        >
          {copy.openInEarth}
        </a>
      ) : null}
      <Link
        href={ROUTES.home}
        className="min-h-touch-target inline-flex items-center self-start text-secondary text-text-secondary"
      >
        {webCopy.backToEarth}
      </Link>
    </section>
  )
}
