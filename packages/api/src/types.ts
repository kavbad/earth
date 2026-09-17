/**
 * Structural types for everything `@earth/api` is injected with (ARCHITECTURE §7).
 *
 * supabase-js and `fetch` are described by the slice of their surface the client uses, so a real
 * `SupabaseClient` / global `fetch` satisfy them and tests use in-memory fakes without a network or
 * a database. `src/types.compat.test.ts` asserts at compile time that `SupabaseClient` is
 * assignable to {@link SupabaseLike}.
 */

// ---------------------------------------------------------------------------
// PostgREST (rpc + the few direct table/view reads)
// ---------------------------------------------------------------------------

/** `PostgrestError` satisfies this: `message` carries the Earth code for `raise exception` errors. */
export interface PostgrestErrorLike {
  readonly message: string
  /** SQLSTATE (`P0001` for Earth RPC errors, `42501` for RLS) or a `PGRSTnnn` code. */
  readonly code?: string | null | undefined
  readonly details?: string | null | undefined
  readonly hint?: string | null | undefined
}

export interface PostgrestResultLike {
  readonly data: unknown
  readonly error: PostgrestErrorLike | null
}

/** RPC arguments as PostgREST receives them: snake_case keys per DB_API.md. */
export type RpcArgs = Readonly<Record<string, unknown>>

/** PostgREST filter operators the client uses (`.filter(column, operator, value)`). */
export const FILTER_OPERATORS = { eq: 'eq' } as const
export type FilterOperator = (typeof FILTER_OPERATORS)[keyof typeof FILTER_OPERATORS]

/**
 * A `select` chain; the builder is thenable so `await` resolves it. Filters go through
 * `filter(column, operator, value)` rather than `eq(...)`: postgrest-js types `eq` generically
 * over the row, which makes `SupabaseClient` → `SupabaseLike` assignability blow the instantiation
 * depth limit, while `filter` compares cleanly (see `types.compat.test.ts`).
 */
export interface SelectQueryLike extends PromiseLike<PostgrestResultLike> {
  filter(column: string, operator: FilterOperator, value: unknown): SelectQueryLike
  order(column: string, options?: { ascending?: boolean }): SelectQueryLike
  limit(count: number): SelectQueryLike
  maybeSingle(): PromiseLike<PostgrestResultLike>
  single(): PromiseLike<PostgrestResultLike>
}

export interface InsertSelectLike {
  single(): PromiseLike<PostgrestResultLike>
}

export interface InsertQueryLike {
  select(columns?: string): InsertSelectLike
}

export interface TableLike {
  select(columns?: string): SelectQueryLike
  insert(values: Readonly<Record<string, unknown>>): InsertQueryLike
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Subset of supabase-js `FileBody` that exists on web, Node and React Native. */
export type StorageBody = Blob | ArrayBuffer | ArrayBufferView | string

export interface StorageErrorLike {
  readonly message: string
  readonly name?: string | undefined
}

export interface StorageUploadOptions {
  readonly contentType?: string | undefined
  readonly upsert?: boolean | undefined
  readonly cacheControl?: string | undefined
}

export interface StorageUploadResult {
  readonly data: { readonly path: string } | null
  readonly error: StorageErrorLike | null
}

export interface StorageSignedUrlResult {
  readonly data: { readonly signedUrl: string } | null
  readonly error: StorageErrorLike | null
}

export interface StorageBucketLike {
  upload(
    path: string,
    body: StorageBody,
    options?: StorageUploadOptions,
  ): Promise<StorageUploadResult>
  getPublicUrl(path: string): { readonly data: { readonly publicUrl: string } }
  createSignedUrl(path: string, expiresIn: number): Promise<StorageSignedUrlResult>
}

export interface StorageLike {
  from(bucket: string): StorageBucketLike
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface SessionLike {
  readonly access_token: string
}

export interface AuthUserLike {
  readonly id: string
  readonly is_anonymous?: boolean | undefined
}

export interface AuthLike {
  getSession(): Promise<{
    readonly data: { readonly session: SessionLike | null }
    readonly error: unknown
  }>
  getUser(): Promise<{
    readonly data: { readonly user: AuthUserLike | null }
    readonly error: unknown
  }>
}

// ---------------------------------------------------------------------------
// The client surface
// ---------------------------------------------------------------------------

/** The slice of `SupabaseClient` `@earth/api` uses. Realtime channels are consumed by `@earth/realtime`. */
export interface SupabaseLike {
  rpc(name: string, args?: RpcArgs): PromiseLike<PostgrestResultLike>
  from(table: string): TableLike
  readonly storage: StorageLike
  readonly auth: AuthLike
}

// ---------------------------------------------------------------------------
// Server tier fetch
// ---------------------------------------------------------------------------

export interface ServerFetchInit {
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  /** Present only when there is a JSON body (never an explicit `undefined`, so `RequestInit` accepts it). */
  readonly body?: string
}

export interface ServerFetchResponse {
  readonly ok: boolean
  readonly status: number
  text(): Promise<string>
}

/** The slice of `fetch` used for `/api/*` routes; the global `fetch` (web, Node, React Native) satisfies it. */
export type ServerFetch = (input: string, init: ServerFetchInit) => Promise<ServerFetchResponse>

/** Supabase access token of the caller, or `null`/`undefined` for Visitors. */
export type AccessTokenGetter = () => Promise<string | null | undefined> | string | null | undefined
