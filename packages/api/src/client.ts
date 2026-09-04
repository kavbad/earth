/**
 * `createEarthClient` — the typed application API of ARCHITECTURE §7. Clients never call
 * `supabase.rpc` outside this package: every method validates its input with the zod input schema,
 * calls the RPC / server route named in DB_API.md, converts errors to `EarthError` and validates
 * the result with the DTO schema from `@earth/domain`.
 */
import {
  type AnalyticsNamespace,
  type DiagnosticsNamespace,
  createAnalyticsNamespace,
  createDiagnosticsNamespace,
} from './namespaces/telemetry'
import {
  type ConversationsNamespace,
  createConversationsNamespace,
} from './namespaces/conversations'
import {
  type FeedNamespace,
  type LiveNamespace,
  type LocationNamespace,
  type MapNamespace,
  type PlacesNamespace,
  type SearchNamespace,
  createFeedNamespace,
  createLiveNamespace,
  createLocationNamespace,
  createMapNamespace,
  createPlacesNamespace,
  createSearchNamespace,
} from './namespaces/discovery'
import { type GroupsNamespace, createGroupsNamespace } from './namespaces/groups'
import {
  type ClaimNamespace,
  type FlagsNamespace,
  type IdentityNamespace,
  type MeNamespace,
  type MediaNamespace,
  type SettingsNamespace,
  createClaimNamespace,
  createFlagsNamespace,
  createIdentityNamespace,
  createMeNamespace,
  createMediaNamespace,
  createSettingsNamespace,
} from './namespaces/identity'
import {
  type NotificationsNamespace,
  type PresenceNamespace,
  createNotificationsNamespace,
  createPresenceNamespace,
} from './namespaces/notifications'
import { type PostsNamespace, createPostsNamespace } from './namespaces/posts'
import {
  type GuestNamespace,
  type RoomsNamespace,
  createGuestNamespace,
  createRoomsNamespace,
} from './namespaces/rooms'
import {
  type SafetyNamespace,
  type SocialNamespace,
  createSafetyNamespace,
  createSocialNamespace,
} from './namespaces/social'
import { type Transport, createTransport, defaultRandomId } from './transport'
import type { AccessTokenGetter, ServerFetch, SupabaseLike } from './types'

export interface EarthClientOptions {
  /** supabase-js client (anon key; carries the caller's session). */
  readonly supabase: SupabaseLike
  /** `API_BASE_URL` — origin of the `/api/*` server tier; a trailing slash is tolerated. */
  readonly serverBaseUrl: string
  /** Defaults to the global `fetch`. */
  readonly fetch?: ServerFetch | undefined
  /** Bearer for server routes; defaults to `supabase.auth.getSession()`. */
  readonly getAccessToken?: AccessTokenGetter | undefined
  /** Random ids for storage keys; defaults to `crypto.randomUUID`. */
  readonly randomId?: (() => string) | undefined
}

export interface EarthClient {
  readonly flags: FlagsNamespace
  readonly settings: SettingsNamespace
  readonly me: MeNamespace
  readonly claim: ClaimNamespace
  readonly identity: IdentityNamespace
  readonly media: MediaNamespace
  readonly groups: GroupsNamespace
  readonly conversations: ConversationsNamespace
  readonly rooms: RoomsNamespace
  readonly guest: GuestNamespace
  readonly feed: FeedNamespace
  readonly live: LiveNamespace
  readonly posts: PostsNamespace
  readonly social: SocialNamespace
  readonly search: SearchNamespace
  readonly notifications: NotificationsNamespace
  readonly location: LocationNamespace
  readonly places: PlacesNamespace
  readonly map: MapNamespace
  readonly safety: SafetyNamespace
  readonly presence: PresenceNamespace
  readonly analytics: AnalyticsNamespace
  readonly diagnostics: DiagnosticsNamespace
  /** The caller's access token (`null` for Visitors) — for `@earth/analytics` / `@earth/observability` sinks. */
  accessToken(): Promise<string | null>
  /** The transport, for packages that add routes without re-implementing error handling. */
  readonly transport: Transport
}

/**
 * Every client method rejects instead of throwing: input validation runs synchronously inside the
 * namespaces, so their functions are wrapped to turn a synchronous `EarthError` into a rejected
 * promise. Nested namespaces are wrapped recursively; non-function members are kept as they are.
 */
export function rejectInsteadOfThrow<T extends object>(namespace: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(namespace)) {
    if (typeof value === 'function') {
      const method = value as (...args: unknown[]) => unknown
      out[key] = (...args: unknown[]): Promise<unknown> => {
        try {
          return Promise.resolve(method(...args))
        } catch (error) {
          return Promise.reject(error)
        }
      }
    } else if (typeof value === 'object' && value !== null) {
      out[key] = rejectInsteadOfThrow(value as object)
    } else {
      out[key] = value
    }
  }
  return out as T
}

function globalFetch(): ServerFetch {
  return (input, init) => {
    const fetchImpl = (globalThis as { fetch?: unknown }).fetch
    if (typeof fetchImpl !== 'function') {
      return Promise.reject(new Error('fetch is not available; pass `fetch` to createEarthClient'))
    }
    return (fetchImpl as ServerFetch)(input, init)
  }
}

export function createEarthClient(options: EarthClientOptions): EarthClient {
  const transport = createTransport({
    supabase: options.supabase,
    serverBaseUrl: options.serverBaseUrl,
    fetch: options.fetch ?? globalFetch(),
    getAccessToken: options.getAccessToken,
    randomId: options.randomId ?? defaultRandomId,
  })
  const media = createMediaNamespace(transport)
  const wrap = rejectInsteadOfThrow
  return {
    flags: wrap(createFlagsNamespace(transport)),
    settings: wrap(createSettingsNamespace(transport)),
    me: wrap(createMeNamespace(transport)),
    claim: wrap(createClaimNamespace(transport)),
    identity: wrap(createIdentityNamespace(transport, media)),
    media: wrap(media),
    groups: wrap(createGroupsNamespace(transport)),
    conversations: wrap(createConversationsNamespace(transport)),
    rooms: wrap(createRoomsNamespace(transport)),
    guest: wrap(createGuestNamespace(transport)),
    feed: wrap(createFeedNamespace(transport)),
    live: wrap(createLiveNamespace(transport)),
    posts: wrap(createPostsNamespace(transport)),
    social: wrap(createSocialNamespace(transport)),
    search: wrap(createSearchNamespace(transport)),
    notifications: wrap(createNotificationsNamespace(transport)),
    location: wrap(createLocationNamespace(transport)),
    places: wrap(createPlacesNamespace(transport)),
    map: wrap(createMapNamespace(transport)),
    safety: wrap(createSafetyNamespace(transport)),
    presence: wrap(createPresenceNamespace(transport)),
    analytics: wrap(createAnalyticsNamespace(transport)),
    diagnostics: wrap(createDiagnosticsNamespace(transport)),
    accessToken: transport.accessToken,
    transport,
  }
}
