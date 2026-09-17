/**
 * A room link opened in the app (spec §112; SCREEN 17 on a phone with Earth installed): the
 * preview — faces and names, the context, who shared it, who can join — then, for a Human,
 * Join on camera / Join audio / Just watch through `room_invite_join`, with SCREEN 16 first when
 * the room is a wider Live. A Visitor sees the same preview with "Claim your place" and, when
 * the room takes Guests, the way to the web Guest page — Guests join from the web (SCREEN 17–19).
 */
import {
  type MediaState,
  type RoomVisibility,
  activeParticipantCount,
  asGroupId,
  roomInviteUrl,
} from '@earth/domain'
import { APP_NAME, colors, copy, participantSummary, space, spacing, touchTarget } from '@earth/ui'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { Button } from '@/components/ui/Button'
import { FaceStack } from '@/components/ui/FaceStack'
import { LiveMark } from '@/components/ui/LiveMark'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusLine } from '@/components/ui/StatusLine'
import { text } from '@/components/ui/text'
import { roomCopy } from '@/features/rooms/copy'
import { roomRoute } from '@/features/rooms/routes'
import { useRoomShell } from '@/features/rooms/shell'
import { isLinkUnusable } from '@/features/rooms/state/closed'
import { VIEWER_CONSENT_LEVEL, consentDecision } from '@/features/rooms/state/consent'
import {
  type InviteAction,
  inviteActions,
  invitePreviewHost,
  invitePreviewMeta,
  invitePreviewTitle,
  mediaStateForAction,
} from '@/features/rooms/state/invite'
import { markClaimTracked } from '@/lib/claim/tracking'
import { CANONICAL_WEB_ORIGIN } from '@/lib/deeplinks'
import { errorCode } from '@/lib/errors'
import { lightTap } from '@/lib/haptics'
import { ROUTES } from '@/lib/routes'

import { ConsentSheet } from './ConsentSheet'

export interface RoomInviteScreenProps {
  /** The invite token from the link; `null` when the URL carried none. */
  readonly token: string | null
}

interface ConsentPrompt {
  readonly level: RoomVisibility
  readonly mediaState: MediaState
}

export const ROOM_INVITE_QUERY_KEY = 'room-invite' as const

export function RoomInviteScreen({ token }: RoomInviteScreenProps) {
  const { earth, ready, sessionStatus, roleKind, online, flags, webOrigin, track } = useRoomShell()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [busy, setBusy] = useState<MediaState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [consent, setConsent] = useState<ConsentPrompt | null>(null)
  const shownConsent = useRef<Set<RoomVisibility>>(new Set())

  const preview = useQuery({
    queryKey: [ROOM_INVITE_QUERY_KEY, token],
    queryFn: () => earth.rooms.invites.preview(token ?? ''),
    enabled: ready && token !== null,
    retry: false,
  })
  const data = preview.data
  const roomId = data?.roomId ?? null

  useEffect(() => {
    if (consent === null || roomId === null || shownConsent.current.has(consent.level)) return
    shownConsent.current.add(consent.level)
    track('participant_consent_shown', { roomId, level: consent.level, trigger: 'join' })
  }, [consent, roomId, track])

  const home = useCallback(() => router.replace(ROUTES.home), [router])

  const join = useCallback(
    async (mediaState: MediaState, consentLevel: RoomVisibility) => {
      if (token === null) return
      setBusy(mediaState)
      setError(null)
      try {
        const room = await earth.rooms.joinWithInvite({ token, mediaState, consentLevel })
        lightTap()
        track('room_joined', {
          roomId: room.id,
          mediaState,
          role: room.myParticipant?.role ?? 'participant',
          contextType: room.contextType,
          ...(room.contextType === 'group' && room.contextId !== null
            ? { groupId: asGroupId(room.contextId) }
            : {}),
          participantCount: activeParticipantCount(room),
        })
        router.replace(roomRoute(room.id))
      } catch (cause) {
        const code = errorCode(cause)
        if (code === 'consent_required' && mediaState !== 'watching') {
          // The room widened since the preview: ask again at its current visibility.
          const fresh = await preview.refetch()
          setConsent({ level: fresh.data?.visibility ?? consentLevel, mediaState })
        } else if (isLinkUnusable(code)) {
          setError(roomCopy.linkNotUsable)
        } else if (code === 'join_not_allowed' || code === 'not_visible') {
          setError(roomCopy.joinNotAllowed)
        } else {
          setError(roomCopy.somethingWrong)
        }
        setBusy(null)
      }
    },
    [token, earth, track, router, preview],
  )

  const requestJoin = useCallback(
    (mediaState: MediaState) => {
      if (data === undefined || token === null) return
      lightTap()
      track('live_join_requested', { roomId: data.roomId, mediaState, source: 'invite' })
      if (mediaState === 'watching') {
        void join('watching', VIEWER_CONSENT_LEVEL)
        return
      }
      const decision = consentDecision({
        room: { visibility: data.visibility, pendingVisibility: null },
        myConsentLevel: null,
        mediaState,
      })
      if (decision.showSheet) {
        setConsent({ level: decision.level, mediaState })
        return
      }
      void join(mediaState, decision.level)
    },
    [data, token, track, join],
  )

  const onConsentChoice = useCallback(
    (choice: MediaState) => {
      const prompt = consent
      if (prompt === null) return
      setConsent(null)
      if (choice === 'watching') {
        void join('watching', VIEWER_CONSENT_LEVEL)
        return
      }
      if (roomId !== null) {
        track('participant_consent_accepted', { roomId, level: prompt.level, trigger: 'join' })
      }
      void join(choice, prompt.level)
    },
    [consent, roomId, track, join],
  )

  const openOnWeb = useCallback(() => {
    if (token === null) return
    lightTap()
    void WebBrowser.openBrowserAsync(roomInviteUrl(webOrigin ?? CANONICAL_WEB_ORIGIN, token))
  }, [token, webOrigin])

  const claim = useCallback(() => {
    lightTap()
    track('claim_started', { entry: 'room_invite', hasGroupInvite: false })
    markClaimTracked()
    router.push(ROUTES.claim)
  }, [track, router])

  const act = (action: InviteAction) => {
    switch (action) {
      case 'join_camera':
      case 'join_audio':
      case 'watch': {
        const mediaState = mediaStateForAction(action)
        if (mediaState !== null) requestJoin(mediaState)
        return
      }
      case 'guest_web':
        openOnWeb()
        return
      case 'claim':
        claim()
        return
    }
  }

  const wordmark = (
    <Pressable
      onPress={home}
      accessibilityRole="link"
      accessibilityLabel={roomCopy.backToEarth}
      style={styles.wordmark}
    >
      <Text style={[text.title, text.primary]}>{APP_NAME}</Text>
    </Pressable>
  )
  const frame = (children: ReactNode) => (
    <View
      style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom + space[6] }]}
    >
      {wordmark}
      {children}
    </View>
  )

  if (token === null || preview.isError) {
    return frame(
      <View style={styles.section}>
        <Text style={[text.title, text.primary]} accessibilityRole="header">
          {roomCopy.linkNotUsable}
        </Text>
        {!online ? (
          <StatusLine
            message={copy.waitingForConnection}
            actionLabel={roomCopy.retry}
            onAction={() => void preview.refetch()}
          />
        ) : null}
        <Button variant="quiet" label={roomCopy.backToEarth} onPress={home} />
      </View>,
    )
  }

  if (data === undefined || sessionStatus === 'loading') {
    return frame(
      <View style={styles.section} accessibilityLabel={roomCopy.loading}>
        <Skeleton width={space[16]} height={space[16]} round />
        <Skeleton width="70%" height={space[6]} />
        <Skeleton width="40%" height={space[4]} />
      </View>,
    )
  }

  if (data.ended) {
    return frame(
      <View style={styles.section}>
        <Text style={[text.title, text.primary]} accessibilityRole="header">
          {roomCopy.roomEnded}
        </Text>
        <Button variant="quiet" label={roomCopy.backToEarth} onPress={home} />
      </View>,
    )
  }

  const actions = inviteActions({ preview: data, roleKind, flags })
  const joining = busy !== null
  const names = data.participants.map((participant) => participant.displayName)

  return frame(
    <View style={styles.section}>
      <LiveMark />
      {data.participants.length > 0 ? (
        <FaceStack
          people={data.participants}
          size="large"
          label={participantSummary(names, data.participants.length)}
        />
      ) : null}
      <Text style={[text.title, text.primary]} accessibilityRole="header">
        {invitePreviewTitle(data)}
      </Text>
      <Text style={[text.secondary, text.muted]}>{invitePreviewMeta(data)}</Text>
      {!online ? <StatusLine banner message={copy.waitingForConnection} /> : null}
      <View style={styles.actions}>
        {actions.map((action, index) => {
          switch (action) {
            case 'join_camera':
              return (
                <Button
                  key={action}
                  variant="primary"
                  fullWidth
                  loading={busy === 'camera'}
                  disabled={joining || !online}
                  label={copy.joinOnCamera}
                  onPress={() => act(action)}
                />
              )
            case 'join_audio':
              return (
                <Button
                  key={action}
                  variant="secondary"
                  fullWidth
                  loading={busy === 'audio'}
                  disabled={joining || !online}
                  label={copy.joinAudio}
                  onPress={() => act(action)}
                />
              )
            case 'watch':
              return (
                <Button
                  key={action}
                  variant="quiet"
                  fullWidth
                  loading={busy === 'watching'}
                  disabled={joining || !online}
                  label={copy.justWatch}
                  onPress={() => act(action)}
                />
              )
            case 'guest_web':
              return (
                <View key={action} style={styles.guest}>
                  <Text style={[text.secondary, text.muted]}>{roomCopy.guestsOnWeb}</Text>
                  <Button
                    variant="secondary"
                    fullWidth
                    label={roomCopy.openOnWeb}
                    onPress={() => act(action)}
                  />
                </View>
              )
            case 'claim':
              return (
                <Button
                  key={action}
                  variant={index === 0 ? 'primary' : 'quiet'}
                  fullWidth
                  label={copy.claimYourPlace}
                  onPress={() => act(action)}
                />
              )
          }
        })}
      </View>
      {error !== null ? <StatusLine message={error} danger /> : null}
      {consent !== null ? (
        <ConsentSheet
          open
          initiatorName={invitePreviewHost(data)}
          level={consent.level}
          busy={joining}
          onChoose={onConsentChoice}
          onClose={() => setConsent(null)}
        />
      ) : null}
    </View>,
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background, paddingHorizontal: spacing.screenMargin },
  wordmark: { minHeight: touchTarget, justifyContent: 'center', alignSelf: 'flex-start' },
  section: {
    paddingVertical: space[8],
    gap: space[4],
    maxWidth: 480,
    width: '100%',
    alignSelf: 'center',
  },
  actions: { gap: space[2], marginTop: space[2] },
  guest: { gap: space[2] },
})
