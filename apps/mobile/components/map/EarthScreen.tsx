/**
 * SCREEN 20 — Earth map. Header: the radius. The map fills the screen. Friends: shared friends,
 * group Lives, friends' Moments; Neighborhood / City: public Live clusters and Places; World: the
 * zoomed-out globe with public Live clusters. Objects come from `map_objects` for the settled box
 * (debounced); a tapped Live expands into `/rooms/[id]` (spec §95). The device position is asked
 * for only here ("Use my location") or on an explicit share, when-in-use, and is converted to
 * area context (`context_resolve_and_set`) — coordinates never reach analytics.
 */
import { FeatureFlag } from '@earth/config'
import { asPlaceId, isUuid } from '@earth/domain'
import { borderWidth, colors, copy, radius, space, spacing, touchTarget, zIndex } from '@earth/ui'
import { useQuery } from '@tanstack/react-query'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { RadiusControl } from '@/components/shell/RadiusControl'
import { ShellScreenHeader } from '@/components/shell/ScreenHeader'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { IconButton } from '@/components/ui/IconButton'
import { Screen } from '@/components/ui/Screen'
import { Sheet } from '@/components/ui/Sheet'
import { Spinner } from '@/components/ui/Spinner'
import { text } from '@/components/ui/text'
import { earthCopy, locationCopy, mapCopy } from '@/features/earth/copy'
import { errorCode } from '@/features/earth/errors'
import { lightTap } from '@/features/earth/haptics'
import { useArea } from '@/features/earth/hooks/useArea'
import { usePreselectedAudience, useShareAudiences } from '@/features/earth/hooks/useAudiences'
import { useLiveCards, useMapObjects } from '@/features/earth/hooks/useMapObjects'
import { useMyShares } from '@/features/earth/hooks/useMyShares'
import { useShareUpdater } from '@/features/earth/hooks/useShareUpdater'
import { deviceLocation } from '@/features/earth/location'
import { EARTH_QUERY, firstParam, momentRoute } from '@/features/earth/routes'
import { useEarthScope, useEarthShell } from '@/features/earth/shell'
import { type LiveMapItem, clusterLives, isCluster } from '@/features/earth/state/cluster'
import { messageForFailure, requestPosition } from '@/features/earth/state/location'
import {
  EMPTY_MARKERS,
  type FriendMarker,
  type LiveMarker,
  type MarkerSets,
  type MomentMarker,
  type PlaceMarker,
  activeFriends,
  toMarkers,
} from '@/features/earth/state/markers'
import {
  LOCATE_ZOOM,
  MOVE_DEBOUNCE_MS,
  PLACE_ZOOM,
  boundsForRegion,
  regionForView,
  viewForScope,
} from '@/features/earth/state/view'

import { ShareLocationSheet } from '../location/ShareLocationSheet'
import { VisibleSharesList } from '../location/VisibleSharesList'
import { useLiveExpand } from './LiveExpand'
import { MapObjectsList } from './MapObjectsList'
import { MapProvider } from './MapProvider'
import {
  ClusterMarkerView,
  FriendMarkerView,
  LiveMarkerView,
  MomentMarkerView,
  PlaceMarkerView,
} from './Markers'
import {
  type EarthMap,
  type LatLng,
  type MapBounds,
  type MapMoveState,
  type MapStatus,
  type MarkerLayer,
  type ScreenPoint,
  markerLayer,
} from './types'

type SheetKind = 'none' | 'list' | 'share' | 'shares'
type EarthParams = {
  readonly place?: string | string[]
  readonly share?: string | string[]
  readonly you?: string | string[]
}

export const PLACE_QUERY_KEY = 'place' as const
const CLOCK_INTERVAL_MS = 30_000
/** Layer order: moments under everything, then places, friends, Lives on top. */
const LAYER_Z = { moment: 1, place: 2, friend: 3, live: 4 } as const

export function EarthScreen() {
  const shell = useEarthShell()
  const [sheet, setSheet] = useState<SheetKind>('none')
  const isGuest = shell.roleKind === 'guest'
  const sharingOn = shell.isHuman && shell.flags[FeatureFlag.LOCATION_SHARING_ENABLED]

  return (
    <Screen accessibilityLabel={copy.tabs.earth}>
      <ShellScreenHeader
        title={copy.tabs.earth}
        trailing={
          <View style={styles.headerActions}>
            {sharingOn ? (
              <IconButton
                name="share"
                label={mapCopy.shareWhereYouAre}
                color={colors.textSecondary}
                onPress={() => setSheet('share')}
              />
            ) : null}
            <Button
              variant="quiet"
              compact
              label={mapCopy.listView}
              onPress={() => (isGuest ? shell.openClaim('public_world') : setSheet('list'))}
            />
          </View>
        }
      >
        <RadiusControl surface="earth" />
      </ShellScreenHeader>
      {isGuest ? (
        <EmptyState
          title={mapCopy.guestsNoMap}
          action={
            <Button
              variant="primary"
              label={copy.claimYourPlace}
              onPress={() => shell.openClaim('public_world')}
            />
          }
        />
      ) : (
        <EarthMapBody sheet={sheet} setSheet={setSheet} sharingOn={sharingOn} />
      )}
    </Screen>
  )
}

interface EarthMapBodyProps {
  readonly sheet: SheetKind
  readonly setSheet: (next: SheetKind) => void
  readonly sharingOn: boolean
}

function EarthMapBody({ sheet, setSheet, sharingOn }: EarthMapBodyProps) {
  const shell = useEarthShell()
  const { earth, track } = shell
  const { scope, availability, setScope } = useEarthScope()
  const router = useRouter()
  const params = useLocalSearchParams<EarthParams>()
  const placeParam = firstParam(params[EARTH_QUERY.place])
  const shareParam = firstParam(params[EARTH_QUERY.share])
  const youParam = firstParam(params[EARTH_QUERY.you]) !== null
  const expand = useLiveExpand()
  const isHuman = shell.isHuman

  // ---------------------------------------------------------------- camera
  const [map, setMap] = useState<EarthMap | null>(null)
  const [status, setStatus] = useState<MapStatus>('loading')
  // The first radius decides where the map opens; later moves go through `map.setView`.
  const [initialView] = useState(() => viewForScope(scope, null))
  const [settledBounds, setBounds] = useState<MapBounds>(() =>
    boundsForRegion(regionForView(initialView)),
  )
  const [zoom, setZoom] = useState<number>(initialView.zoom)
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onMove = useCallback((state: MapMoveState) => {
    setZoom(state.zoom)
    if (moveTimer.current !== null) clearTimeout(moveTimer.current)
    moveTimer.current = setTimeout(() => setBounds(state.bounds), MOVE_DEBOUNCE_MS)
  }, [])
  useEffect(
    () => () => {
      if (moveTimer.current !== null) clearTimeout(moveTimer.current)
    },
    [],
  )

  const context = shell.me?.context ?? null
  const homeCityId = context?.homeCityId ?? null
  const contextCityId = context?.currentCityId ?? homeCityId
  const cityId = youParam && homeCityId !== null ? homeCityId : contextCityId
  const cityQuery = useArea(cityId)
  const city: LatLng | null = cityQuery.data?.centroid ?? null

  // The radius decides the camera (spec §52); the city arriving later re-centres once.
  useEffect(() => {
    if (map === null) return
    map.setView(viewForScope(scope, city))
  }, [map, scope, city])

  // "Your Earth" (SCREEN 24): home city, own Moments — the Friends radius when it is open.
  useEffect(() => {
    if (!youParam || !isHuman) return
    if (scope !== 'friends' && availability.friends === 'available') setScope('friends')
  }, [youParam, isHuman, scope, availability.friends, setScope])

  // `/earth?place=…` — a tagged Place from a chat or a post.
  const placeId = placeParam !== null && isUuid(placeParam) ? placeParam : null
  const placeQuery = useQuery({
    queryKey: [PLACE_QUERY_KEY, placeId],
    queryFn: () => earth.places.get(asPlaceId(placeId ?? '')),
    enabled: shell.ready && placeId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const [tappedPlaceId, setActivePlaceId] = useState<string | null>(null)
  const activePlaceId = tappedPlaceId ?? placeQuery.data?.id ?? null
  const place = placeQuery.data
  useEffect(() => {
    if (map === null || place === undefined) return
    map.setView({ center: { lat: place.lat, lng: place.lng }, zoom: PLACE_ZOOM })
  }, [map, place])

  // A coarse clock for expiry (shares end on their own; the server sweeps, the map stops drawing).
  const [now, setNow] = useState(0)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const interval = setInterval(tick, CLOCK_INTERVAL_MS)
    return () => {
      clearTimeout(first)
      clearInterval(interval)
    }
  }, [])

  // ---------------------------------------------------------------- objects
  const publicWorldOff =
    !isHuman &&
    !shell.flags[FeatureFlag.PUBLIC_WORLD_ENABLED] &&
    !shell.flags[FeatureFlag.PUBLIC_LIVE_ENABLED]
  const canQuery = status === 'ready' && !publicWorldOff && (isHuman || scope === 'world')
  const objects = useMapObjects({ scope, bounds: settledBounds, enabled: canQuery })
  const liveCards = useLiveCards(scope, canQuery)
  const objectsData = objects.data
  const cards = liveCards.data?.cards
  const markers: MarkerSets = useMemo(
    () => (objectsData === undefined ? EMPTY_MARKERS : toMarkers(objectsData, cards ?? [])),
    [objectsData, cards],
  )
  const friends = useMemo(
    () => (now === 0 ? markers.friends : activeFriends(markers.friends, now)),
    [markers.friends, now],
  )
  const liveItems: LiveMapItem[] = useMemo(
    () => clusterLives(markers.lives, zoom),
    [markers.lives, zoom],
  )

  const viewedWorld = useRef(false)
  useEffect(() => {
    if (viewedWorld.current) return
    if (shell.sessionStatus === 'ready' && shell.roleKind === 'visitor' && scope === 'world') {
      viewedWorld.current = true
      track('public_world_viewed', { surface: 'earth', scope: 'world' })
    }
  }, [shell.sessionStatus, shell.roleKind, scope, track])

  const seenRooms = useRef(new Set<string>())
  useEffect(() => {
    markers.lives.forEach((live, index) => {
      if (seenRooms.current.has(live.roomId)) return
      seenRooms.current.add(live.roomId)
      track('live_card_impression', {
        roomId: live.roomId,
        surface: 'earth',
        scope,
        position: index,
        participantCount: live.participantCount,
      })
    })
  }, [markers.lives, scope, track])

  const openLive = useCallback(
    (marker: LiveMarker, point: ScreenPoint | null) => {
      lightTap()
      const position = markers.lives.findIndex((live) => live.id === marker.id)
      track('live_card_opened', {
        roomId: marker.roomId,
        surface: 'earth',
        scope,
        position: Math.max(0, position),
      })
      setSheet('none')
      expand.start(marker.roomId, point)
    },
    [markers.lives, track, scope, expand, setSheet],
  )

  const [selectedFriend, setSelectedFriend] = useState<FriendMarker | null>(null)

  const layers: readonly MarkerLayer[] = useMemo(
    () => [
      markerLayer<MomentMarker>({
        kind: 'moment',
        items: markers.moments,
        zIndex: LAYER_Z.moment,
        render: (marker) => <MomentMarkerView marker={marker} />,
        onTap: (marker) => router.push(momentRoute(marker.postId)),
      }),
      markerLayer<PlaceMarker>({
        kind: 'place',
        items: markers.places,
        zIndex: LAYER_Z.place,
        render: (marker) => (
          <PlaceMarkerView marker={marker} active={marker.placeId === activePlaceId} />
        ),
        onTap: (marker) => setActivePlaceId(marker.placeId),
      }),
      markerLayer<FriendMarker>({
        kind: 'friend',
        items: friends,
        zIndex: LAYER_Z.friend,
        render: (marker) => <FriendMarkerView marker={marker} />,
        onTap: (marker) => setSelectedFriend(marker),
      }),
      markerLayer<LiveMapItem>({
        kind: 'live',
        items: liveItems,
        zIndex: LAYER_Z.live,
        render: (item) =>
          isCluster(item) ? <ClusterMarkerView cluster={item} /> : <LiveMarkerView marker={item} />,
        onTap: (item, point) => {
          if (isCluster(item)) {
            lightTap()
            map?.fitBounds(item.bounds)
          } else {
            openLive(item, point)
          }
        },
      }),
    ],
    [markers.moments, markers.places, friends, liveItems, activePlaceId, router, map, openLive],
  )

  // ---------------------------------------------------------------- location
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)

  const locate = useCallback(async () => {
    if (map === null || locating) return
    lightTap()
    setLocating(true)
    setLocationError(null)
    const result = await requestPosition(deviceLocation(), { requestPermission: true })
    if (!result.ok) {
      setLocationError(messageForFailure(result.failure))
      setLocating(false)
      return
    }
    map.setView({ center: result.position, zoom: LOCATE_ZOOM })
    if (isHuman) {
      try {
        await earth.location.resolveAndSetContext(result.position)
        await shell.refreshSession()
        void objects.refetch()
      } catch {
        // The map still moved; the area context catches up next time.
      }
    }
    setLocating(false)
  }, [map, locating, isHuman, earth, shell, objects])

  // ---------------------------------------------------------------- sharing
  const audiences = useShareAudiences(sharingOn)
  const myShares = useMyShares({ enabled: sharingOn, known: audiences.audiences })
  useShareUpdater(myShares.shares, sharingOn)

  const preselected = usePreselectedAudience(shareParam, sharingOn)
  const openedFromParam = useRef<string | null>(null)
  useEffect(() => {
    if (preselected === null || shareParam === null || openedFromParam.current === shareParam)
      return
    openedFromParam.current = shareParam
    setSheet('share')
  }, [preselected, shareParam, setSheet])

  // ---------------------------------------------------------------- failure states (spec §110)
  const failure =
    objects.error === undefined || objects.error === null ? null : errorCode(objects.error)
  const needsLocation = failure === 'area_not_found'
  const refreshFailed = failure !== null && !needsLocation

  const focusOn = (position: LatLng, zoomTo: number) => {
    map?.setView({ center: position, zoom: zoomTo })
    setSheet('none')
  }

  return (
    <MapProvider
      initialView={initialView}
      layers={layers}
      onMove={onMove}
      onReady={setMap}
      onStatusChange={setStatus}
    >
      {status === 'loading' ? (
        <View style={styles.loading} pointerEvents="none">
          <Spinner label={mapCopy.loadingMap} />
        </View>
      ) : null}

      <View style={styles.notices} pointerEvents="box-none">
        {status === 'failed' ? <Notice>{mapCopy.mapFailed}</Notice> : null}
        {publicWorldOff ? <Notice>{mapCopy.worldOff}</Notice> : null}
        {!shell.online && objectsData === undefined ? (
          <Notice>{copy.waitingForConnection}</Notice>
        ) : null}
        {objects.isFetching && objectsData === undefined && !objects.isError ? <Spinner /> : null}
        {refreshFailed ? (
          <Notice>
            <View style={styles.noticeRow}>
              <Text style={[text.secondary, text.muted]}>{copy.couldntRefresh}</Text>
              <Button
                variant="quiet"
                compact
                label={earthCopy.retry}
                onPress={() => void objects.refetch()}
              />
            </View>
          </Notice>
        ) : null}
        {needsLocation ? (
          <Notice>
            <View style={styles.noticeStack}>
              <Text style={[text.secondary, text.muted]}>{mapCopy.needLocation(scope)}</Text>
              <Button
                variant="secondary"
                compact
                loading={locating}
                label={mapCopy.useMyLocation}
                onPress={() => void locate()}
              />
            </View>
          </Notice>
        ) : null}
        {locationError !== null ? (
          <Notice>
            <Text style={[text.secondary, text.muted]} accessibilityLiveRegion="assertive">
              {locationError}
            </Text>
          </Notice>
        ) : null}
      </View>

      <View style={styles.locate}>
        <View style={styles.locateButton}>
          <IconButton
            name="location"
            label={locating ? mapCopy.locating : mapCopy.useMyLocation}
            busy={locating}
            disabled={status !== 'ready'}
            onPress={() => void locate()}
          />
        </View>
      </View>

      {selectedFriend !== null ? (
        <View style={styles.friendLine} accessibilityLiveRegion="polite">
          <Text style={[text.body, text.primary, styles.friendText]} numberOfLines={1}>
            <Text style={text.bodyMedium}>{selectedFriend.displayName}</Text>
            <Text style={text.muted}>
              {' · '}
              {mapCopy.precision[selectedFriend.precision]}
            </Text>
          </Text>
          <Button
            variant="quiet"
            compact
            label={copy.done}
            onPress={() => setSelectedFriend(null)}
          />
        </View>
      ) : null}

      {shell.roleKind === 'visitor' && scope !== 'world' ? (
        <View style={styles.claim}>
          <Button
            variant="primary"
            label={copy.claimYourPlace}
            onPress={() => shell.openClaim('public_world')}
          />
        </View>
      ) : null}

      <MapObjectsList
        open={sheet === 'list'}
        markers={{ ...markers, friends }}
        onClose={() => setSheet('none')}
        onOpenLive={(marker) => {
          setSheet('none')
          void map?.project(marker.position).then((point) => openLive(marker, point))
        }}
        onFocusFriend={(marker) => {
          setSelectedFriend(marker)
          focusOn(marker.position, LOCATE_ZOOM)
        }}
        onFocusPlace={(marker) => {
          setActivePlaceId(marker.placeId)
          focusOn(marker.position, PLACE_ZOOM)
        }}
        onOpenMoment={(marker) => {
          setSheet('none')
          router.push(momentRoute(marker.postId))
        }}
      />

      {sharingOn ? (
        <>
          <ShareLocationSheet
            open={sheet === 'share'}
            audience={preselected}
            audiences={audiences.audiences}
            onClose={() => setSheet('none')}
            onShared={(share, audience) => {
              myShares.add(share, audience.name)
              shell.toast(locationCopy.sharedWith(audience.name))
              setSheet('shares')
            }}
          />
          <Sheet
            open={sheet === 'shares'}
            onClose={() => setSheet('none')}
            title={copy.groupInfo.locationSharing}
            closeButton
            scroll
          >
            <VisibleSharesList
              mine={myShares.shares}
              friends={friends}
              busyShareId={myShares.revoking}
              onRevoke={(share) => void myShares.revoke(share)}
              onFocusFriend={(marker) => {
                setSelectedFriend(marker)
                focusOn(marker.position, LOCATE_ZOOM)
              }}
            />
            {friends.length > 0 || myShares.shares.length > 0 ? null : (
              <Text style={[text.secondary, text.muted, styles.boundedNote]}>
                {locationCopy.boundedNote}
              </Text>
            )}
            <View style={styles.sheetAction}>
              <Button
                variant="secondary"
                fullWidth
                label={mapCopy.shareWhereYouAre}
                onPress={() => setSheet('share')}
              />
            </View>
          </Sheet>
        </>
      ) : null}

      {expand.overlay}
    </MapProvider>
  )
}

function Notice({ children }: { readonly children: ReactNode }) {
  return (
    <View style={styles.notice} accessibilityLiveRegion="polite">
      {typeof children === 'string' ? (
        <Text style={[text.secondary, text.muted]}>{children}</Text>
      ) : (
        children
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', alignItems: 'center' },
  loading: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notices: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    padding: spacing.screenMargin,
    gap: space[2],
    alignItems: 'flex-start',
    zIndex: zIndex.raised,
  },
  notice: {
    backgroundColor: colors.background,
    borderRadius: radius.medium,
    borderWidth: borderWidth.separator,
    borderColor: colors.separator,
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    maxWidth: '100%',
  },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  noticeStack: { gap: space[2], alignItems: 'flex-start' },
  locate: {
    position: 'absolute',
    right: spacing.screenMargin,
    bottom: spacing.screenMargin,
    zIndex: zIndex.raised,
  },
  locateButton: {
    width: touchTarget,
    height: touchTarget,
    borderRadius: radius.avatar,
    backgroundColor: colors.background,
    borderWidth: borderWidth.separator,
    borderColor: colors.separator,
    alignItems: 'center',
    justifyContent: 'center',
  },
  friendLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space[3],
    paddingHorizontal: spacing.screenMargin,
    paddingVertical: space[3],
    backgroundColor: colors.background,
    borderTopWidth: borderWidth.hairline,
    borderTopColor: colors.separator,
    zIndex: zIndex.raised,
  },
  friendText: { flexShrink: 1 },
  claim: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: spacing.screenMargin,
    alignItems: 'center',
    zIndex: zIndex.raised,
  },
  boundedNote: { paddingTop: space[3] },
  sheetAction: { paddingTop: space[4] },
})
