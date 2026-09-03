/**
 * `feed`, `live`, `search`, `map`, `places` and `location` (DB_API §4, §5, §9; ARCHITECTURE §6, §9;
 * spec PART IX, PART XI).
 */
import {
  type AreaDto,
  AreaDtoSchema,
  type AreaId,
  AreaIdSchema,
  type BoundingBox,
  type FeedPageDto,
  FeedPageDtoSchema,
  type HumanContextDto,
  HumanContextDtoSchema,
  type LatLngDto,
  LatLngDtoSchema,
  type LiveListDto,
  LiveListDtoSchema,
  type LocationShareDto,
  LocationShareDtoSchema,
  type LocationShareInput,
  LocationShareInputSchema,
  type MapFriendDto,
  MapFriendDtoSchema,
  type MapObjectsDto,
  MapObjectsDtoSchema,
  type PlaceDto,
  PlaceDtoSchema,
  type PlaceId,
  PlaceIdSchema,
  SEARCH_SECTION_SIZE,
  type Scope,
  type SearchResultsDto,
  SearchResultsDtoSchema,
  SearchInputSchema,
} from '@earth/domain'
import { z } from 'zod'

import {
  type AreaResolutionDto,
  AreaResolutionDtoSchema,
  type ContextSetInput,
  ContextSetInputSchema,
  FeedPageInputSchema,
  LiveListInputSchema,
  type LocationShareUpdateInput,
  LocationShareUpdateInputSchema,
  MapObjectsInputSchema,
  type PlaceCreateInput,
  PlaceCreateInputSchema,
  type PlacesSearchInput,
  PlacesSearchInputSchema,
  type ScopeSetInput,
  ScopeSetInputSchema,
} from '../dto'
import { RPC, SERVER_QUERY, SERVER_ROUTES } from '../rpc'
import { arrayOrKeyed } from '../schemas'
import { type Transport, parseInput } from '../transport'

export interface FeedNamespace {
  /** `GET /api/feed?scope=&cursor=&area=`; Visitors may read `world` only. */
  page(scope: Scope, cursor?: string | null, areaId?: AreaId | null): Promise<FeedPageDto>
}

export interface LiveNamespace {
  /** `GET /api/live?scope=&area=` (SCREEN 13). */
  list(scope: Scope, areaId?: AreaId | null): Promise<LiveListDto>
}

export interface SearchNamespace {
  /** `search(q, limit)` (DB_API §9). */
  query(q: string, limit?: number): Promise<SearchResultsDto>
}

export interface MapNamespace {
  /** `map_objects(scope, min_lat, min_lng, max_lat, max_lng)`; `bbox` is `[west, south, east, north]`. */
  objects(scope: Scope, bbox: BoundingBox): Promise<MapObjectsDto>
}

export interface PlacesNamespace {
  /** `places_search(q, area_id)`. */
  search(input: PlacesSearchInput): Promise<PlaceDto[]>
  /** `place_get(id)`. */
  get(placeId: PlaceId): Promise<PlaceDto>
  /** `place_create(name, lat, lng, area_id, category)`. */
  create(input: PlaceCreateInput): Promise<PlaceDto>
}

export interface LocationNamespace {
  /** `area_resolve(lat, lng)`: the position is never stored. */
  resolveArea(position: LatLngDto): Promise<AreaResolutionDto>
  /** `areas_search(q)`. */
  searchAreas(q: string): Promise<AreaDto[]>
  /** `area_get(id)`. */
  getArea(areaId: AreaId): Promise<AreaDto>
  /** `context_set(current_area_id, current_city_id, home_city_id)`; only ids, never coordinates. */
  setContext(input: ContextSetInput): Promise<HumanContextDto>
  /** `area_resolve` then `context_set` with the resolved neighborhood/city. */
  resolveAndSetContext(position: LatLngDto): Promise<AreaResolutionDto>
  /** `scope_set(surface, scope)`: remembers the scope per surface (spec §51). */
  setScope(input: ScopeSetInput): Promise<void>
  /** `location_share_create(...)`; requires `LOCATION_SHARING_ENABLED`, always time-bounded. */
  share(input: LocationShareInput): Promise<LocationShareDto>
  /** `location_share_update(share_id, lat, lng)`. */
  updateShare(input: LocationShareUpdateInput): Promise<void>
  /** `location_share_revoke(share_id)`. */
  revokeShare(shareId: string): Promise<void>
  /** `location_shares_visible()`: positions already degraded by precision. */
  visibleShares(): Promise<MapFriendDto[]>
}

const ShareIdSchema = z.uuid()
const SearchLimitSchema = z.int().min(1).max(50)
const AreaQuerySchema = SearchInputSchema.shape.q
const PlacesResultSchema = arrayOrKeyed(PlaceDtoSchema, 'places')
const AreasResultSchema = arrayOrKeyed(AreaDtoSchema, 'areas')
const SharesResultSchema = arrayOrKeyed(MapFriendDtoSchema, 'shares')
const SECONDS_PER_MINUTE = 60

export function createFeedNamespace(transport: Transport): FeedNamespace {
  return {
    page(scope, cursor = null, areaId = null) {
      const parsed = parseInput(FeedPageInputSchema, { scope, cursor, areaId })
      return transport.server(
        {
          method: 'GET',
          path: SERVER_ROUTES.feed,
          query: {
            [SERVER_QUERY.scope]: parsed.scope,
            [SERVER_QUERY.cursor]: parsed.cursor ?? null,
            [SERVER_QUERY.area]: parsed.areaId ?? null,
          },
          auth: 'optional',
        },
        FeedPageDtoSchema,
      )
    },
  }
}

export function createLiveNamespace(transport: Transport): LiveNamespace {
  return {
    list(scope, areaId = null) {
      const parsed = parseInput(LiveListInputSchema, { scope, areaId })
      return transport.server(
        {
          method: 'GET',
          path: SERVER_ROUTES.live,
          query: { [SERVER_QUERY.scope]: parsed.scope, [SERVER_QUERY.area]: parsed.areaId ?? null },
          auth: 'optional',
        },
        LiveListDtoSchema,
      )
    },
  }
}

export function createSearchNamespace(transport: Transport): SearchNamespace {
  return {
    query(q, limit = SEARCH_SECTION_SIZE) {
      const parsed = parseInput(SearchInputSchema, { q })
      const max = parseInput(SearchLimitSchema, limit, 'limit')
      return transport.rpc(RPC.search, { q: parsed.q, limit: max }, SearchResultsDtoSchema)
    },
  }
}

export function createMapNamespace(transport: Transport): MapNamespace {
  return {
    objects(scope, bbox) {
      const parsed = parseInput(MapObjectsInputSchema, { scope, bbox })
      const [west, south, east, north] = parsed.bbox
      return transport.rpc(
        RPC.mapObjects,
        { scope: parsed.scope, min_lat: south, min_lng: west, max_lat: north, max_lng: east },
        MapObjectsDtoSchema,
      )
    },
  }
}

export function createPlacesNamespace(transport: Transport): PlacesNamespace {
  return {
    search(input) {
      const parsed = parseInput(PlacesSearchInputSchema, input)
      return transport.rpc(
        RPC.placesSearch,
        { q: parsed.q, area_id: parsed.areaId ?? null },
        PlacesResultSchema,
      )
    },
    get(placeId) {
      const id = parseInput(PlaceIdSchema, placeId, 'placeId')
      return transport.rpc(RPC.placeGet, { id }, PlaceDtoSchema)
    },
    create(input) {
      const parsed = parseInput(PlaceCreateInputSchema, input)
      return transport.rpc(
        RPC.placeCreate,
        {
          name: parsed.name,
          lat: parsed.position.lat,
          lng: parsed.position.lng,
          area_id: parsed.areaId,
          category: parsed.category ?? null,
        },
        PlaceDtoSchema,
      )
    },
  }
}

export function createLocationNamespace(transport: Transport): LocationNamespace {
  const resolveArea = (position: LatLngDto): Promise<AreaResolutionDto> => {
    const parsed = parseInput(LatLngDtoSchema, position, 'position')
    return transport.rpc(
      RPC.areaResolve,
      { lat: parsed.lat, lng: parsed.lng },
      AreaResolutionDtoSchema,
    )
  }

  const setContext = (input: ContextSetInput): Promise<HumanContextDto> => {
    const parsed = parseInput(ContextSetInputSchema, input)
    return transport.rpc(
      RPC.contextSet,
      {
        current_area_id: parsed.currentAreaId ?? null,
        current_city_id: parsed.currentCityId ?? null,
        home_city_id: parsed.homeCityId ?? null,
      },
      HumanContextDtoSchema,
    )
  }

  return {
    resolveArea,
    searchAreas(q) {
      const query = parseInput(AreaQuerySchema, q, 'q')
      return transport.rpc(RPC.areasSearch, { q: query }, AreasResultSchema)
    },
    getArea(areaId) {
      const id = parseInput(AreaIdSchema, areaId, 'areaId')
      return transport.rpc(RPC.areaGet, { id }, AreaDtoSchema)
    },
    setContext,
    async resolveAndSetContext(position) {
      const resolution = await resolveArea(position)
      await setContext({
        currentAreaId: resolution.neighborhood?.id ?? null,
        currentCityId: resolution.city?.id ?? null,
      })
      return resolution
    },
    setScope(input) {
      const parsed = parseInput(ScopeSetInputSchema, input)
      return transport.rpcVoid(RPC.scopeSet, { surface: parsed.surface, scope: parsed.scope })
    },
    share(input) {
      const parsed = parseInput(LocationShareInputSchema, input)
      return transport.rpc(
        RPC.locationShareCreate,
        {
          audience_type: parsed.audienceType,
          audience_id: parsed.audienceId,
          precision: parsed.precision,
          duration_seconds: parsed.durationMinutes * SECONDS_PER_MINUTE,
          lat: parsed.position.lat,
          lng: parsed.position.lng,
        },
        LocationShareDtoSchema,
      )
    },
    updateShare(input) {
      const parsed = parseInput(LocationShareUpdateInputSchema, input)
      return transport.rpcVoid(RPC.locationShareUpdate, {
        share_id: parsed.shareId,
        lat: parsed.position.lat,
        lng: parsed.position.lng,
      })
    },
    revokeShare(shareId) {
      const id = parseInput(ShareIdSchema, shareId, 'shareId')
      return transport.rpcVoid(RPC.locationShareRevoke, { share_id: id })
    },
    visibleShares: () => transport.rpc(RPC.locationSharesVisible, {}, SharesResultSchema),
  }
}
