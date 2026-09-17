/**
 * `feed`, `live`, `search`, `map`, `places` and `location` (DB_API §4, §5, §9; ARCHITECTURE §6, §9;
 * spec PART IX, PART XI).
 */
import {
  type AreaDto,
  type AreaId,
  AreaIdSchema,
  type BoundingBox,
  type FeedPageDto,
  type HumanContextDto,
  type LatLngDto,
  LatLngDtoSchema,
  type LiveListDto,
  type LocationShareDto,
  type LocationShareInput,
  LocationShareInputSchema,
  type MapFriendDto,
  type MapObjectsDto,
  type PlaceDto,
  type PlaceId,
  PlaceIdSchema,
  SEARCH_SECTION_SIZE,
  type Scope,
  type SearchResultsDto,
  SearchInputSchema,
} from '@earth/domain'
import { z } from 'zod'

import {
  type AreaResolutionDto,
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
import { CALLS } from '../manifest'
import { SERVER_QUERY } from '../rpc'
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
  /**
   * `context_resolve_and_set(lat, lng)`: resolves the position to its neighborhood / city and
   * stores those ids as the current context in one call (DB_API §5); the position is never stored.
   */
  resolveAndSetContext(position: LatLngDto): Promise<HumanContextDto>
  /** `scope_set(surface, scope)`: remembers the scope per surface (spec §51). */
  setScope(input: ScopeSetInput): Promise<void>
  /** `location_share_create(...)`; requires `LOCATION_SHARING_ENABLED`, always time-bounded. */
  share(input: LocationShareInput): Promise<LocationShareDto>
  /** `location_share_update(share_id, lat, lng)`: the share afterwards. */
  updateShare(input: LocationShareUpdateInput): Promise<LocationShareDto>
  /** `location_share_revoke(share_id)`: the revoked share. */
  revokeShare(shareId: string): Promise<LocationShareDto>
  /** `location_shares_visible()`: positions already degraded by precision. */
  visibleShares(): Promise<MapFriendDto[]>
  /** `location_shares_mine()`: the caller's own live shares (not revoked, not expired), no positions. */
  myShares(): Promise<LocationShareDto[]>
}

const ShareIdSchema = z.uuid()
const SearchLimitSchema = z.int().min(1).max(50)
const AreaQuerySchema = SearchInputSchema.shape.q
const SECONDS_PER_MINUTE = 60

export function createFeedNamespace(transport: Transport): FeedNamespace {
  return {
    page(scope, cursor = null, areaId = null) {
      const parsed = parseInput(FeedPageInputSchema, { scope, cursor, areaId })
      return transport.route(CALLS.feedPage, {
        query: {
          [SERVER_QUERY.scope]: parsed.scope,
          [SERVER_QUERY.cursor]: parsed.cursor ?? null,
          [SERVER_QUERY.area]: parsed.areaId ?? null,
        },
      })
    },
  }
}

export function createLiveNamespace(transport: Transport): LiveNamespace {
  return {
    list(scope, areaId = null) {
      const parsed = parseInput(LiveListInputSchema, { scope, areaId })
      return transport.route(CALLS.liveList, {
        query: { [SERVER_QUERY.scope]: parsed.scope, [SERVER_QUERY.area]: parsed.areaId ?? null },
      })
    },
  }
}

export function createSearchNamespace(transport: Transport): SearchNamespace {
  return {
    query(q, limit = SEARCH_SECTION_SIZE) {
      const parsed = parseInput(SearchInputSchema, { q })
      const max = parseInput(SearchLimitSchema, limit, 'limit')
      return transport.call(CALLS.searchQuery, { q: parsed.q, limit: max })
    },
  }
}

export function createMapNamespace(transport: Transport): MapNamespace {
  return {
    objects(scope, bbox) {
      const parsed = parseInput(MapObjectsInputSchema, { scope, bbox })
      const [west, south, east, north] = parsed.bbox
      return transport.call(CALLS.mapObjects, {
        scope: parsed.scope,
        min_lat: south,
        min_lng: west,
        max_lat: north,
        max_lng: east,
      })
    },
  }
}

export function createPlacesNamespace(transport: Transport): PlacesNamespace {
  return {
    search(input) {
      const parsed = parseInput(PlacesSearchInputSchema, input)
      return transport.call(CALLS.placesSearch, { q: parsed.q, area_id: parsed.areaId ?? null })
    },
    get(placeId) {
      const id = parseInput(PlaceIdSchema, placeId, 'placeId')
      return transport.call(CALLS.placesGet, { id })
    },
    create(input) {
      const parsed = parseInput(PlaceCreateInputSchema, input)
      return transport.call(CALLS.placesCreate, {
        name: parsed.name,
        lat: parsed.position.lat,
        lng: parsed.position.lng,
        area_id: parsed.areaId,
        category: parsed.category ?? null,
      })
    },
  }
}

export function createLocationNamespace(transport: Transport): LocationNamespace {
  return {
    resolveArea(position) {
      const parsed = parseInput(LatLngDtoSchema, position, 'position')
      return transport.call(CALLS.locationResolveArea, { lat: parsed.lat, lng: parsed.lng })
    },
    searchAreas(q) {
      const query = parseInput(AreaQuerySchema, q, 'q')
      return transport.call(CALLS.locationSearchAreas, { q: query })
    },
    getArea(areaId) {
      const id = parseInput(AreaIdSchema, areaId, 'areaId')
      return transport.call(CALLS.locationGetArea, { id })
    },
    setContext(input) {
      const parsed = parseInput(ContextSetInputSchema, input)
      return transport.call(CALLS.locationSetContext, {
        current_area_id: parsed.currentAreaId ?? null,
        current_city_id: parsed.currentCityId ?? null,
        home_city_id: parsed.homeCityId ?? null,
      })
    },
    resolveAndSetContext(position) {
      const parsed = parseInput(LatLngDtoSchema, position, 'position')
      return transport.call(CALLS.locationResolveAndSetContext, {
        lat: parsed.lat,
        lng: parsed.lng,
      })
    },
    setScope(input) {
      const parsed = parseInput(ScopeSetInputSchema, input)
      return transport.call(CALLS.locationSetScope, {
        surface: parsed.surface,
        scope: parsed.scope,
      })
    },
    share(input) {
      const parsed = parseInput(LocationShareInputSchema, input)
      return transport.call(CALLS.locationShare, {
        audience_type: parsed.audienceType,
        audience_id: parsed.audienceId,
        precision: parsed.precision,
        duration_seconds: parsed.durationMinutes * SECONDS_PER_MINUTE,
        lat: parsed.position.lat,
        lng: parsed.position.lng,
      })
    },
    updateShare(input) {
      const parsed = parseInput(LocationShareUpdateInputSchema, input)
      return transport.call(CALLS.locationUpdateShare, {
        share_id: parsed.shareId,
        lat: parsed.position.lat,
        lng: parsed.position.lng,
      })
    },
    revokeShare(shareId) {
      const id = parseInput(ShareIdSchema, shareId, 'shareId')
      return transport.call(CALLS.locationRevokeShare, { share_id: id })
    },
    visibleShares: () => transport.call(CALLS.locationVisibleShares, {}),
    myShares: () => transport.call(CALLS.locationMyShares, {}),
  }
}
