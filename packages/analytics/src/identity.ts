/**
 * Identity and base properties attached to every event (EARTH_V1_SPEC.md §96).
 *
 * Spec names are snake_case (`human_id`, `anonymous_visitor_id`, `guest_session_id`,
 * `app_version`, `platform`, `timestamp`); this package uses the camelCase equivalents as the
 * contract and wire keys. The anonymous visitor id is a device-level uuid that survives sign-out
 * so Visitor → Guest → Human funnels can be joined; apps persist it through
 * `AnonymousVisitorIdStorage`.
 */
import type { GuestSessionId, HumanId } from '@earth/domain'

export const ANALYTICS_PLATFORMS = ['ios', 'android', 'web', 'server'] as const
export type AnalyticsPlatform = (typeof ANALYTICS_PLATFORMS)[number]

export interface AnalyticsIdentity {
  humanId?: HumanId
  anonymousVisitorId?: string
  guestSessionId?: GuestSessionId
}

export interface BaseProperties {
  appVersion: string
  platform: AnalyticsPlatform
  /** ISO-8601 instant the event happened on the emitting device. */
  timestamp: string
}

/**
 * Property keys reserved for identity and base properties. Event shapes never name a base key.
 * Among the identity keys only `guestSessionId` may appear in an event shape: `guest_*` events name
 * another person's session (the Guest a moderator removed) and `human_claimed` names the session
 * the new Human previously held. Event properties win on merge (`./client.ts`). Both rules are
 * enforced at compile time in `./contract.ts` (`EVENT_MAP_HAS_NO_BASE_KEYS`,
 * `EVENT_MAP_OVERRIDES_ONLY_GUEST_SESSION`).
 */
export const IDENTITY_PROPERTY_KEYS = ['humanId', 'anonymousVisitorId', 'guestSessionId'] as const
export type IdentityPropertyKey = (typeof IDENTITY_PROPERTY_KEYS)[number]
export const BASE_PROPERTY_KEYS = ['appVersion', 'platform', 'timestamp'] as const
export type BasePropertyKey = (typeof BASE_PROPERTY_KEYS)[number]
export const RESERVED_PROPERTY_KEYS = [...IDENTITY_PROPERTY_KEYS, ...BASE_PROPERTY_KEYS] as const
export type ReservedPropertyKey = (typeof RESERVED_PROPERTY_KEYS)[number]

/** Distinct id used by vendor adapters. Humans first, then Guests; Visitors stay anonymous. */
export function distinctIdFor(identity: AnalyticsIdentity): string | undefined {
  return identity.humanId ?? identity.guestSessionId ?? identity.anonymousVisitorId
}

/** Identity as it appears on the wire: only the keys that are set. */
export function identityProperties(identity: AnalyticsIdentity): Partial<AnalyticsIdentity> {
  const out: Partial<AnalyticsIdentity> = {}
  if (identity.humanId !== undefined) out.humanId = identity.humanId
  if (identity.anonymousVisitorId !== undefined) {
    out.anonymousVisitorId = identity.anonymousVisitorId
  }
  if (identity.guestSessionId !== undefined) out.guestSessionId = identity.guestSessionId
  return out
}

/** Reads the identity back out of merged event properties (used by stateless server adapters). */
export function identityFromProperties(
  properties: Readonly<Record<string, unknown>>,
): AnalyticsIdentity {
  const identity: AnalyticsIdentity = {}
  const humanId = properties['humanId']
  const anonymousVisitorId = properties['anonymousVisitorId']
  const guestSessionId = properties['guestSessionId']
  if (typeof humanId === 'string') identity.humanId = humanId as HumanId
  if (typeof anonymousVisitorId === 'string') identity.anonymousVisitorId = anonymousVisitorId
  if (typeof guestSessionId === 'string') identity.guestSessionId = guestSessionId as GuestSessionId
  return identity
}

export interface CreateBasePropertiesOptions {
  appVersion: string
  platform: AnalyticsPlatform
  /** Injected clock; defaults to `Date.now`. */
  now?: () => number
}

/** Builds the `base` getter `createAnalytics` expects; stamps a fresh timestamp per event. */
export function createBaseProperties(options: CreateBasePropertiesOptions): () => BaseProperties {
  const now = options.now ?? Date.now
  return () => ({
    appVersion: options.appVersion,
    platform: options.platform,
    timestamp: new Date(now()).toISOString(),
  })
}

// ---------------------------------------------------------------------------
// Anonymous visitor id
// ---------------------------------------------------------------------------

export const ANONYMOUS_VISITOR_ID_STORAGE_KEY = 'earth.analytics.anonymous_visitor_id' as const

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isAnonymousVisitorId(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_REGEX.test(value)
}

interface CryptoLike {
  randomUUID?: () => string
  getRandomValues?: (array: Uint8Array) => Uint8Array
}

function cryptoLike(): CryptoLike | undefined {
  const candidate = (globalThis as { crypto?: unknown }).crypto
  return typeof candidate === 'object' && candidate !== null ? (candidate as CryptoLike) : undefined
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const crypto = cryptoLike()
  if (typeof crypto?.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
    return bytes
  }
  // Last-resort fallback for runtimes without WebCrypto (old Hermes). Not for secrets.
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

function formatUuidV4(bytes: Uint8Array): string {
  const b = Array.from(bytes)
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const hex = b.map((n) => n.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** A fresh v4 uuid via `crypto.randomUUID` when available, otherwise from random bytes. */
export function createAnonymousVisitorId(): string {
  const crypto = cryptoLike()
  if (typeof crypto?.randomUUID === 'function') {
    const id = crypto.randomUUID()
    if (isAnonymousVisitorId(id)) return id
  }
  return formatUuidV4(randomBytes(16))
}

/**
 * Minimal persistence contract apps satisfy with `localStorage`, `expo-secure-store`,
 * `AsyncStorage`, … Both methods may be sync or async.
 */
export interface AnonymousVisitorIdStorage {
  get(key: string): string | null | undefined | Promise<string | null | undefined>
  set(key: string, value: string): void | Promise<void>
}

export interface ResolveAnonymousVisitorIdOptions {
  storage: AnonymousVisitorIdStorage
  key?: string
  /** Injected generator (tests); defaults to {@link createAnonymousVisitorId}. */
  generate?: () => string
}

/**
 * Returns the persisted anonymous visitor id, creating and storing one when missing or malformed.
 * Storage failures never break the app: the id is still returned for this session.
 */
export async function resolveAnonymousVisitorId(
  options: ResolveAnonymousVisitorIdOptions,
): Promise<string> {
  const key = options.key ?? ANONYMOUS_VISITOR_ID_STORAGE_KEY
  const generate = options.generate ?? createAnonymousVisitorId
  let existing: string | null | undefined
  try {
    existing = await options.storage.get(key)
  } catch {
    existing = undefined
  }
  if (isAnonymousVisitorId(existing)) return existing
  const created = generate()
  try {
    await options.storage.set(key, created)
  } catch {
    // Best effort: a non-persisted id still identifies this session.
  }
  return created
}

/** In-memory storage for tests and server processes. */
export function createMemoryVisitorIdStorage(
  initial: Readonly<Record<string, string>> = {},
): AnonymousVisitorIdStorage & { readonly values: Map<string, string> } {
  const values = new Map<string, string>(Object.entries(initial))
  return {
    values,
    get: (key) => values.get(key) ?? null,
    set: (key, value) => {
      values.set(key, value)
    },
  }
}
