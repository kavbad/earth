'use client'

/**
 * SCREEN 20 — Earth map. Header: the radius. The map fills the screen. Friends: shared friends,
 * group Lives, friends' Moments; Neighborhood / City: public Live clusters and Places; World: the
 * zoomed-out globe with public Live clusters. Objects come from `map_objects` for the settled box
 * (debounced); a tapped Live expands into `/rooms/[id]` (spec §95). The device position is asked
 * for only here ("Use my location") or on an explicit share, and is converted to area context
 * (`area_resolve` + `context_set`) — coordinates never reach analytics.
 */
import { FeatureFlag } from '@earth/config'
import {
  type ConversationDetailDto,
  type Scope,
  asAreaId,
  asConversationId,
  asPlaceId,
} from '@earth/domain'
import { copy } from '@earth/ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouter, useSearchParams } from 'next/navigation'
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { webCopy } from '../../lib/copy'
import { errorCode } from '../../lib/errors'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useFlags } from '../../lib/providers/FlagsProvider'
import { useEarth, usePublicEnv, useRuntime } from '../../lib/providers/RuntimeProvider'
import { useScope } from '../../lib/providers/ScopeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { localStore } from '../../lib/storage'
import { locationCopy } from '../location/copy'
import { browserGeolocation, messageForFailure, requestPosition } from '../location/geolocation'
import {
  type MyShare,
  addMyShare,
  readMyShares,
  removeMyShare,
  writeMyShares,
} from '../location/state/myShares'
import { type ShareAudience, ShareLocationSheet } from '../location/ShareLocationSheet'
import { useShareUpdater } from '../location/useShareUpdater'
import { VisibleSharesList } from '../location/VisibleSharesList'
import { useClaimGate } from '../shell/ClaimSheet'
import { CONTENT_MAX_WIDTH_CLASS } from '../shell/PageContainer'
import { RadiusControl } from '../shell/RadiusControl'
import { ScreenHeader } from '../shell/ScreenHeader'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { Icon } from '../ui/Icon'
import { Sheet } from '../ui/Sheet'
import { Spinner } from '../ui/Spinner'
import { useToast } from '../ui/Toast'
import { cx } from '../ui/cx'
import { MapObjectsList } from './MapObjectsList'
import { MapProvider, MarkerLayer, useEarthMap } from './MapProvider'
import {
  ClusterMarkerView,
  FriendMarkerView,
  LiveMarkerView,
  MomentMarkerView,
  PlaceMarkerView,
} from './Markers'
import { mapCopy } from './copy'
import { EARTH_QUERY, momentRoute } from './routes'
import { type LiveMapItem, clusterLives, isCluster } from './state/cluster'
import {
  EMPTY_MARKERS,
  type FriendMarker,
  type LiveMarker,
  type MarkerSets,
  type PlaceMarker,
  activeFriends,
  toMarkers,
} from './state/markers'
import {
  LOCATE_ZOOM,
  MOVE_DEBOUNCE_MS,
  PLACE_ZOOM,
  WORLD_VIEW,
  boundsAround,
  viewForScope,
} from './state/view'
import type { LatLng, MapBounds, MarkerTap } from './types'
import { useLiveExpand } from './useLiveExpand'
import { useLiveCards, useMapObjects } from './useMapObjects'

type SheetKind = 'none' | 'list' | 'share' | 'shares'

export const MY_SHARES_QUERY_KEY = 'my-shares' as const
const EMPTY_SHARES: readonly MyShare[] = []

interface EarthSheets {
  readonly sheet: SheetKind
  readonly setSheet: Dispatch<SetStateAction<SheetKind>>
}

export function EarthScreen() {
  const env = usePublicEnv()
  const session = useSession()
  const flags = useFlags()
  const gate = useClaimGate()
  const [sheet, setSheet] = useState<SheetKind>('none')
  const { scope } = useScope('earth')

  const isHuman = session.roleKind === 'human'
  const sharingOn = isHuman && flags[FeatureFlag.LOCATION_SHARING_ENABLED]
  const subtitle = isHuman ? (session.me?.context?.currentCityName ?? undefined) : undefined

  const initialView = useMemo(() => viewForScope(scope, null), [scope])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScreenHeader
        title={copy.tabs.earth}
        {...(subtitle === undefined ? {} : { subtitle })}
        trailing={
          <div className="flex items-center">
            {sharingOn ? (
              <button
                type="button"
                aria-label={mapCopy.shareWhereYouAre}
                onClick={() => setSheet('share')}
                className="flex size-touch-target items-center justify-center rounded-avatar text-text-secondary transition-colors duration-fast ease-standard hover:bg-subtle-fill"
              >
                <Icon name="share" />
              </button>
            ) : null}
            <Button
              variant="quiet"
              onClick={() =>
                session.roleKind === 'guest' ? gate.open('public_world') : setSheet('list')
              }
            >
              {mapCopy.listView}
            </Button>
          </div>
        }
      >
        <RadiusControl surface="earth" />
      </ScreenHeader>
      {session.roleKind === 'guest' ? (
        <EmptyState
          title={mapCopy.guestsNoMap}
          action={
            <Button variant="primary" onClick={() => gate.open('public_world')}>
              {copy.claimYourPlace}
            </Button>
          }
        />
      ) : (
        <div className="relative min-h-[320px] flex-1">
          <MapProvider
            styleUrl={env?.MAP_STYLE_URL ?? null}
            initialView={initialView}
            className="absolute inset-0"
          >
            <EarthMapBody sheet={sheet} setSheet={setSheet} sharingOn={sharingOn} />
          </MapProvider>
        </div>
      )}
    </div>
  )
}

interface EarthMapBodyProps extends EarthSheets {
  readonly sharingOn: boolean
}

function EarthMapBody({ sheet, setSheet, sharingOn }: EarthMapBodyProps) {
  const { map, status } = useEarthMap()
  const { runtime } = useRuntime()
  const earth = useEarth()
  const session = useSession()
  const flags = useFlags()
  const analytics = useAnalytics()
  const toast = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const gate = useClaimGate()
  const { scope, availability, setScope } = useScope('earth')
  const expand = useLiveExpand()

  const isHuman = session.roleKind === 'human'
  const humanId = session.humanId

  // ---------------------------------------------------------------- camera
  // Until the camera first settles, the map's own box and zoom are the truth.
  const [settledBounds, setBounds] = useState<MapBounds | null>(null)
  const [settledZoom, setZoom] = useState<number | null>(null)
  const bounds: MapBounds | null = settledBounds ?? map?.getBounds() ?? null
  const zoom: number = settledZoom ?? map?.getZoom() ?? WORLD_VIEW.zoom
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (map === null) return
    const off = map.onMove((state) => {
      setZoom(state.zoom)
      if (moveTimer.current !== null) clearTimeout(moveTimer.current)
      moveTimer.current = setTimeout(() => setBounds(state.bounds), MOVE_DEBOUNCE_MS)
    })
    return () => {
      off()
      if (moveTimer.current !== null) clearTimeout(moveTimer.current)
    }
  }, [map])

  const contextCityId =
    session.me?.context?.currentCityId ?? session.me?.context?.homeCityId ?? null
  const homeCityId = session.me?.context?.homeCityId ?? null
  const youParam = searchParams.get(EARTH_QUERY.you) !== null
  const cityId = youParam && homeCityId !== null ? homeCityId : contextCityId
  const cityQuery = useQuery({
    queryKey: ['area', cityId],
    queryFn: () => earth.location.getArea(asAreaId(cityId ?? '')),
    enabled: runtime !== null && cityId !== null,
    staleTime: Number.POSITIVE_INFINITY,
  })
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
  const placeParam = searchParams.get(EARTH_QUERY.place)
  const placeQuery = useQuery({
    queryKey: ['place', placeParam],
    queryFn: () => earth.places.get(asPlaceId(placeParam ?? '')),
    enabled: runtime !== null && placeParam !== null,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const [tappedPlaceId, setActivePlaceId] = useState<string | null>(null)
  const activePlaceId = tappedPlaceId ?? placeQuery.data?.id ?? null
  useEffect(() => {
    if (map === null || placeQuery.data === undefined) return
    map.setView({
      center: { lat: placeQuery.data.lat, lng: placeQuery.data.lng },
      zoom: PLACE_ZOOM,
    })
  }, [map, placeQuery.data])

  // A coarse clock for expiry (shares end on their own; the server sweeps, the map stops drawing).
  const [now, setNow] = useState(0)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    const first = setTimeout(tick, 0)
    const interval = setInterval(tick, 30_000)
    return () => {
      clearTimeout(first)
      clearInterval(interval)
    }
  }, [])

  // ---------------------------------------------------------------- objects
  const publicWorldOff =
    !isHuman && !flags[FeatureFlag.PUBLIC_WORLD_ENABLED] && !flags[FeatureFlag.PUBLIC_LIVE_ENABLED]
  const canQuery = status === 'ready' && !publicWorldOff && (isHuman || scope === 'world')
  const objects = useMapObjects({ scope, bounds, enabled: canQuery })
  const liveCards = useLiveCards(scope, canQuery)
  const markers: MarkerSets = useMemo(
    () =>
      objects.data === undefined
        ? EMPTY_MARKERS
        : toMarkers(objects.data, liveCards.data?.cards ?? []),
    [objects.data, liveCards.data],
  )
  const friends = useMemo(
    () => (now === 0 ? markers.friends : activeFriends(markers.friends, now)),
    [markers.friends, now],
  )
  const liveItems: LiveMapItem[] = useMemo(
    () => clusterLives(markers.lives, zoom),
    [markers.lives, zoom],
  )

  useEffect(() => {
    if (session.status === 'ready' && session.roleKind === 'visitor' && scope === 'world') {
      analytics.track('public_world_viewed', { surface: 'earth', scope: 'world' })
    }
    // Once per visit, not per re-render of the flags.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.status, session.roleKind])

  const seenRooms = useRef(new Set<string>())
  useEffect(() => {
    markers.lives.forEach((live, index) => {
      if (seenRooms.current.has(live.roomId)) return
      seenRooms.current.add(live.roomId)
      analytics.track('live_card_impression', {
        roomId: live.roomId,
        surface: 'earth',
        scope,
        position: index,
        participantCount: live.participantCount,
      })
    })
  }, [markers.lives, scope, analytics])

  const openLive = useCallback(
    (marker: LiveMarker, rect: MarkerTap['rect']) => {
      const position = markers.lives.findIndex((live) => live.id === marker.id)
      analytics.track('live_card_opened', {
        roomId: marker.roomId,
        surface: 'earth',
        scope,
        position: Math.max(0, position),
      })
      setSheet('none')
      expand(marker.roomId, rect)
    },
    [markers.lives, analytics, scope, expand, setSheet],
  )

  const [selectedFriend, setSelectedFriend] = useState<FriendMarker | null>(null)

  useEffect(() => {
    if (map === null) return
    return map.onMarkerTap((tap) => {
      switch (tap.kind) {
        case 'live': {
          const item = liveItems.find((candidate) => candidate.id === tap.id)
          if (item === undefined) return
          if (isCluster(item)) map.fitBounds(item.bounds)
          else openLive(item, tap.rect)
          return
        }
        case 'place':
          setActivePlaceId(tap.id.replace(/^place:/, ''))
          return
        case 'friend': {
          const friend = friends.find((candidate) => candidate.id === tap.id) ?? null
          setSelectedFriend(friend)
          return
        }
        case 'moment': {
          const moment = markers.moments.find((candidate) => candidate.id === tap.id)
          if (moment !== undefined) router.push(momentRoute(moment.postId))
          return
        }
        default: {
          const exhaustive: never = tap.kind
          throw new Error(`Unknown marker kind: ${String(exhaustive)}`)
        }
      }
    })
  }, [map, liveItems, friends, markers.moments, openLive, router])

  // ---------------------------------------------------------------- location
  const [locating, setLocating] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)

  const locate = useCallback(async () => {
    if (map === null) return
    setLocating(true)
    setLocationError(null)
    const result = await requestPosition(browserGeolocation())
    if (!result.ok) {
      setLocationError(messageForFailure(result.failure))
      setLocating(false)
      return
    }
    map.setView({ center: result.position, zoom: LOCATE_ZOOM })
    if (isHuman) {
      try {
        await earth.location.resolveAndSetContext(result.position)
        await session.refresh()
        void objects.refetch()
      } catch {
        // The map still moved; the area context catches up next time.
      }
    }
    setLocating(false)
  }, [map, isHuman, earth, session, objects])

  // ---------------------------------------------------------------- sharing
  // Own shares live on this device (`myShares`); read through the query cache so the map, the
  // list and the updater see one value.
  const queryClient = useQueryClient()
  const mySharesKey = useMemo(() => [MY_SHARES_QUERY_KEY, humanId] as const, [humanId])
  const mySharesQuery = useQuery({
    queryKey: mySharesKey,
    queryFn: () => (humanId === null ? [] : readMyShares(localStore(), humanId, Date.now())),
    enabled: isHuman,
    staleTime: Number.POSITIVE_INFINITY,
  })
  const myShares = useMemo<readonly MyShare[]>(
    () => mySharesQuery.data ?? EMPTY_SHARES,
    [mySharesQuery.data],
  )
  useShareUpdater(myShares, sharingOn)

  const persistShares = useCallback(
    (next: readonly MyShare[]) => {
      if (humanId !== null) writeMyShares(localStore(), humanId, next)
      queryClient.setQueryData(mySharesKey, next)
    },
    [humanId, queryClient, mySharesKey],
  )

  const conversationsQuery = useQuery({
    queryKey: ['conversations', 'audiences', humanId],
    queryFn: () => earth.conversations.list({}),
    enabled: runtime !== null && sharingOn,
    staleTime: 60_000,
  })
  const audiences: ShareAudience[] = useMemo(
    () =>
      (conversationsQuery.data?.conversations ?? [])
        .filter((conversation) => conversation.groupId !== null)
        .map((conversation) => ({
          type: 'group',
          id: conversation.groupId ?? '',
          name: conversation.title,
        })),
    [conversationsQuery.data],
  )

  const shareParam = searchParams.get(EARTH_QUERY.share)
  const shareConversation = useQuery({
    queryKey: ['conversation', shareParam],
    queryFn: () => earth.conversations.get(asConversationId(shareParam ?? '')),
    enabled: runtime !== null && sharingOn && shareParam !== null,
    staleTime: 60_000,
  })
  const preselected = useMemo(
    () =>
      shareConversation.data === undefined
        ? null
        : audienceForConversation(shareConversation.data, humanId),
    [shareConversation.data, humanId],
  )
  const openedFromParam = useRef(false)
  useEffect(() => {
    if (preselected === null || openedFromParam.current) return
    openedFromParam.current = true
    setSheet('share')
  }, [preselected, setSheet])

  const [revoking, setRevoking] = useState<string | null>(null)
  const revoke = useCallback(
    async (share: MyShare) => {
      setRevoking(share.id)
      try {
        await earth.location.revokeShare(share.id)
        persistShares(removeMyShare(myShares, share.id))
        toast.show(locationCopy.stopped)
      } catch {
        toast.show(webCopy.somethingWrong)
      } finally {
        setRevoking(null)
      }
    },
    [earth, myShares, persistShares, toast],
  )

  // ---------------------------------------------------------------- failure states (spec §110)
  const failure =
    objects.error === undefined || objects.error === null ? null : errorCode(objects.error)
  const needsLocation = failure === 'area_not_found'

  const focusOn = (position: LatLng, zoomTo: number) => {
    map?.setView({ center: position, zoom: zoomTo })
    setSheet('none')
  }

  return (
    <>
      <MarkerLayer
        kind="live"
        items={liveItems}
        render={(item) =>
          isCluster(item) ? <ClusterMarkerView cluster={item} /> : <LiveMarkerView marker={item} />
        }
      />
      <MarkerLayer
        kind="place"
        items={markers.places}
        render={(marker: PlaceMarker) => (
          <PlaceMarkerView marker={marker} active={marker.placeId === activePlaceId} />
        )}
      />
      <MarkerLayer
        kind="friend"
        items={friends}
        render={(marker) => <FriendMarkerView marker={marker} />}
      />
      <MarkerLayer
        kind="moment"
        items={markers.moments}
        render={(marker) => <MomentMarkerView marker={marker} />}
      />

      {status === 'loading' ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner label={mapCopy.loadingMap} />
        </div>
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-0 z-raised flex flex-col items-start gap-2 p-screen-margin">
        {status === 'failed' ? <Notice>{mapCopy.mapFailed}</Notice> : null}
        {publicWorldOff ? <Notice>{mapCopy.worldOff}</Notice> : null}
        {objects.isFetching && objects.data === undefined && !objects.isError ? <Spinner /> : null}
        {failure !== null && !needsLocation ? (
          <Notice>
            <span className="flex items-center gap-3">
              {copy.couldntRefresh}
              <Button variant="quiet" onClick={() => void objects.refetch()}>
                {webCopy.retry}
              </Button>
            </span>
          </Notice>
        ) : null}
        {needsLocation ? (
          <Notice>
            <span className="flex flex-col gap-2">
              {mapCopy.needLocation(scope)}
              <Button variant="secondary" loading={locating} onClick={() => void locate()}>
                {mapCopy.useMyLocation}
              </Button>
            </span>
          </Notice>
        ) : null}
        {locationError !== null ? (
          <Notice>
            <span role="alert">{locationError}</span>
          </Notice>
        ) : null}
      </div>

      <div className="absolute right-4 bottom-4 z-raised flex flex-col items-end gap-2">
        <button
          type="button"
          aria-label={locating ? mapCopy.locating : mapCopy.useMyLocation}
          aria-busy={locating || undefined}
          disabled={status !== 'ready'}
          onClick={() => void locate()}
          className={cx(
            'flex size-touch-target items-center justify-center rounded-avatar bg-background text-text-primary ring-1 ring-separator transition-colors duration-fast ease-standard hover:bg-subtle-fill disabled:opacity-50',
          )}
        >
          {locating ? <Spinner label={mapCopy.locating} /> : <Icon name="location" />}
        </button>
      </div>

      {selectedFriend !== null ? (
        <div className="fade-in absolute inset-x-0 bottom-0 z-raised bg-background px-screen-margin py-3 hairline-t">
          <div
            className={cx(
              'mx-auto flex items-center justify-between gap-3',
              CONTENT_MAX_WIDTH_CLASS,
            )}
          >
            <p className="min-w-0 truncate text-body">
              <span className="font-medium">{selectedFriend.displayName}</span>
              <span className="text-text-secondary">
                {' · '}
                {mapCopy.precision[selectedFriend.precision]}
              </span>
            </p>
            <Button variant="quiet" onClick={() => setSelectedFriend(null)}>
              {copy.done}
            </Button>
          </div>
        </div>
      ) : null}

      <MapObjectsList
        open={sheet === 'list'}
        markers={{ ...markers, friends }}
        onClose={() => setSheet('none')}
        onOpenLive={(marker) => {
          const point = map?.project(marker.position) ?? { x: 0, y: 0 }
          openLive(marker, { x: point.x, y: point.y, width: 1, height: 1 })
        }}
        onFocusFriend={(marker) => {
          setSelectedFriend(marker)
          focusOn(marker.position, LOCATE_ZOOM)
        }}
        onFocusPlace={(marker) => {
          setActivePlaceId(marker.placeId)
          focusOn(marker.position, PLACE_ZOOM)
        }}
        onOpenMoment={(marker) => router.push(momentRoute(marker.postId))}
      />

      {sharingOn ? (
        <>
          <ShareLocationSheet
            open={sheet === 'share'}
            audience={preselected}
            audiences={audiences}
            onClose={() => setSheet('none')}
            onShared={(share, audience) => {
              persistShares(
                addMyShare(myShares, {
                  id: share.id,
                  audienceType: share.audienceType,
                  audienceId: share.audienceId,
                  audienceName: audience.name,
                  precision: share.precision,
                  expiresAt: share.expiresAt,
                  createdAt: share.createdAt,
                }),
              )
              toast.show(locationCopy.sharedWith(audience.name))
              setSheet('shares')
            }}
          />
          <Sheet
            open={sheet === 'shares'}
            onClose={() => setSheet('none')}
            title={copy.groupInfo.locationSharing}
            closeButton
          >
            <div className="-mx-screen-margin">
              <VisibleSharesList
                mine={myShares}
                friends={friends}
                busyShareId={revoking}
                onRevoke={(share) => void revoke(share)}
                onFocusFriend={(marker) => {
                  setSelectedFriend(marker)
                  focusOn(marker.position, LOCATE_ZOOM)
                }}
              />
              {friends.length > 0 || myShares.length > 0 ? null : (
                <p className="px-screen-margin pt-3 text-secondary text-text-secondary">
                  {locationCopy.boundedNote}
                </p>
              )}
              <div className="px-screen-margin pt-4">
                <Button variant="secondary" fullWidth onClick={() => setSheet('share')}>
                  {mapCopy.shareWhereYouAre}
                </Button>
              </div>
            </div>
          </Sheet>
        </>
      ) : null}

      {!isHuman && session.roleKind === 'visitor' && scope !== 'world' ? (
        <div className="absolute inset-x-0 bottom-4 z-raised flex justify-center">
          <Button variant="primary" onClick={() => gate.open('public_world')}>
            {copy.claimYourPlace}
          </Button>
        </div>
      ) : null}
    </>
  )
}

function Notice({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="fade-in pointer-events-auto rounded-medium bg-background px-4 py-2 text-secondary text-text-secondary ring-1 ring-separator"
    >
      {children}
    </div>
  )
}

/** The audience a chat hands off with `/earth?share=<conversationId>` (spec §75 "Share with Weekend Crew"). */
export function audienceForConversation(
  conversation: ConversationDetailDto,
  viewerHumanId: string | null,
): ShareAudience | null {
  if (conversation.groupId !== null)
    return { type: 'group', id: conversation.groupId, name: conversation.title }
  const other = conversation.members.find((member) => member.humanId !== viewerHumanId)
  if (other === undefined) return null
  return { type: 'friend', id: other.humanId, name: other.displayName }
}

/** The box around the objects of a set — used to bring a whole answer into view. */
export function boundsForMarkers(markers: MarkerSets): MapBounds | null {
  return boundsAround([
    ...markers.lives.map((m) => m.position),
    ...markers.friends.map((m) => m.position),
    ...markers.places.map((m) => m.position),
    ...markers.moments.map((m) => m.position),
  ])
}

export type { Scope }
