/**
 * In-memory stand-in for the slice of supabase-js `@earth/api` uses: records every `rpc`,
 * table query, storage upload and auth call, and answers from programmable results. No network,
 * no database.
 */
import type {
  AuthUserLike,
  InsertQueryLike,
  PostgrestErrorLike,
  PostgrestResultLike,
  RpcArgs,
  SelectQueryLike,
  StorageBody,
  StorageBucketLike,
  StorageUploadOptions,
  SupabaseLike,
  TableLike,
} from '../types'

export interface RecordedRpcCall {
  readonly name: string
  readonly args: RpcArgs | undefined
}

export interface RecordedFilter {
  readonly column: string
  readonly operator: string
  readonly value: unknown
}

interface MutableQuery {
  table: string
  kind: 'select' | 'insert'
  columns: string | undefined
  values: Readonly<Record<string, unknown>> | undefined
  filters: RecordedFilter[]
  order: { column: string; ascending: boolean } | undefined
  limit: number | undefined
  single: 'single' | 'maybeSingle' | undefined
}

export type RecordedQuery = Readonly<MutableQuery>

export interface RecordedUpload {
  readonly bucket: string
  readonly path: string
  readonly body: StorageBody
  readonly options: StorageUploadOptions | undefined
}

export type RpcResponder = (
  args: RpcArgs | undefined,
) => PostgrestResultLike | Promise<PostgrestResultLike>
export type QueryResponder = (
  query: RecordedQuery,
) => PostgrestResultLike | Promise<PostgrestResultLike>

export interface FakeSupabaseOptions {
  /** Access token `auth.getSession()` reports; `null` for Visitors. */
  readonly accessToken?: string | null | undefined
  readonly user?: AuthUserLike | null | undefined
  /** Base URL of `storage.getPublicUrl`. */
  readonly publicStorageBaseUrl?: string | undefined
}

export interface FakeSupabase extends SupabaseLike {
  readonly rpcCalls: RecordedRpcCall[]
  readonly queries: RecordedQuery[]
  readonly uploads: RecordedUpload[]
  readonly signedUrlRequests: Array<{ bucket: string; path: string; expiresIn: number }>
  sessionCalls: number
  /** Answers `rpc(name)`; a plain value is returned as `{ data: value, error: null }`. */
  onRpc(
    name: string,
    responder: RpcResponder | { data: unknown } | { error: PostgrestErrorLike },
  ): void
  /** A successful `rpc(name)` result. */
  rpcData(name: string, data: unknown): void
  /** A PostgREST error for `rpc(name)`. */
  rpcError(name: string, error: PostgrestErrorLike): void
  /** Makes `rpc(name)` reject (transport failure) instead of resolving. */
  rpcThrows(name: string, error: unknown): void
  /** Answers `from(table)` queries. */
  onQuery(
    table: string,
    responder: QueryResponder | { data: unknown } | { error: PostgrestErrorLike },
  ): void
  /** Programs the next `storage.from(bucket).upload` outcome. */
  uploadError: { message: string } | null
  signedUrlError: { message: string } | null
  lastRpc(): RecordedRpcCall
  lastQuery(): RecordedQuery
}

/** The error shape PostgREST returns for `raise exception using errcode = 'P0001', message = '<code>'`. */
export function postgrestRaise(code: string): PostgrestErrorLike {
  return { message: code, code: 'P0001', details: null, hint: null }
}

function normalizeResponder(
  responder: RpcResponder | QueryResponder | { data: unknown } | { error: PostgrestErrorLike },
): (input: never) => PostgrestResultLike | Promise<PostgrestResultLike> {
  if (typeof responder === 'function') return responder as (input: never) => PostgrestResultLike
  if ('error' in responder) return () => ({ data: null, error: responder.error })
  return () => ({ data: responder.data, error: null })
}

export function createFakeSupabase(options: FakeSupabaseOptions = {}): FakeSupabase {
  const rpcResponders = new Map<
    string,
    (args: RpcArgs | undefined) => PostgrestResultLike | Promise<PostgrestResultLike>
  >()
  const rpcThrowers = new Map<string, unknown>()
  const queryResponders = new Map<
    string,
    (query: RecordedQuery) => PostgrestResultLike | Promise<PostgrestResultLike>
  >()
  const publicBase = (
    options.publicStorageBaseUrl ?? 'https://storage.earth.test/object/public'
  ).replace(/\/+$/, '')

  const answerQuery = async (query: RecordedQuery): Promise<PostgrestResultLike> => {
    const responder = queryResponders.get(query.table)
    if (responder === undefined) {
      return {
        data: null,
        error: { message: `no fake result for table ${query.table}`, code: 'PGRST000' },
      }
    }
    return responder(query)
  }

  const buildTable = (table: string): TableLike => {
    const makeSelect = (query: MutableQuery): SelectQueryLike => {
      const chain: SelectQueryLike = {
        filter(column, operator, value) {
          query.filters.push({ column, operator, value })
          return chain
        },
        order(column, opts) {
          query.order = { column, ascending: opts?.ascending ?? true }
          return chain
        },
        limit(count) {
          query.limit = count
          return chain
        },
        maybeSingle() {
          query.single = 'maybeSingle'
          return answerQuery(query)
        },
        single() {
          query.single = 'single'
          return answerQuery(query)
        },
        then(onfulfilled, onrejected) {
          return answerQuery(query).then(onfulfilled, onrejected)
        },
      }
      return chain
    }
    return {
      select(columns) {
        const query: MutableQuery = {
          table,
          kind: 'select',
          columns,
          values: undefined,
          filters: [],
          order: undefined,
          limit: undefined,
          single: undefined,
        }
        client.queries.push(query)
        return makeSelect(query)
      },
      insert(values) {
        const query: MutableQuery = {
          table,
          kind: 'insert',
          columns: undefined,
          values,
          filters: [],
          order: undefined,
          limit: undefined,
          single: undefined,
        }
        client.queries.push(query)
        const insert: InsertQueryLike = {
          select(columns) {
            query.columns = columns
            return {
              single() {
                query.single = 'single'
                return answerQuery(query)
              },
            }
          },
        }
        return insert
      },
    }
  }

  const bucketApi = (bucket: string): StorageBucketLike => ({
    async upload(path, body, uploadOptions) {
      client.uploads.push({ bucket, path, body, options: uploadOptions })
      if (client.uploadError !== null) return { data: null, error: client.uploadError }
      return { data: { path }, error: null }
    },
    getPublicUrl(path) {
      return { data: { publicUrl: `${publicBase}/${bucket}/${path}` } }
    },
    async createSignedUrl(path, expiresIn) {
      client.signedUrlRequests.push({ bucket, path, expiresIn })
      if (client.signedUrlError !== null) return { data: null, error: client.signedUrlError }
      return {
        data: {
          signedUrl: `${publicBase}/sign/${bucket}/${path}?token=signed&expires=${expiresIn}`,
        },
        error: null,
      }
    },
  })

  const client: FakeSupabase = {
    rpcCalls: [],
    queries: [],
    uploads: [],
    signedUrlRequests: [],
    sessionCalls: 0,
    uploadError: null,
    signedUrlError: null,
    rpc(name, args) {
      client.rpcCalls.push({ name, args })
      const thrown = rpcThrowers.get(name)
      if (thrown !== undefined) return Promise.reject(thrown)
      const responder = rpcResponders.get(name)
      if (responder === undefined) {
        return Promise.resolve({
          data: null,
          error: {
            message: `no fake result for rpc ${name}`,
            code: 'PGRST202',
            details: null,
            hint: null,
          },
        })
      }
      return Promise.resolve(responder(args))
    },
    from: (table) => buildTable(table),
    storage: { from: bucketApi },
    auth: {
      async getSession() {
        client.sessionCalls += 1
        const token = options.accessToken ?? null
        return { data: { session: token === null ? null : { access_token: token } }, error: null }
      },
      async getUser() {
        return { data: { user: options.user ?? null }, error: null }
      },
    },
    onRpc(name, responder) {
      rpcThrowers.delete(name)
      rpcResponders.set(name, normalizeResponder(responder) as RpcResponder)
    },
    rpcData(name, data) {
      client.onRpc(name, { data })
    },
    rpcError(name, error) {
      client.onRpc(name, { error })
    },
    rpcThrows(name, error) {
      rpcThrowers.set(name, error)
    },
    onQuery(table, responder) {
      queryResponders.set(table, normalizeResponder(responder) as QueryResponder)
    },
    lastRpc() {
      const last = client.rpcCalls[client.rpcCalls.length - 1]
      if (last === undefined) throw new Error('no rpc call recorded')
      return last
    },
    lastQuery() {
      const last = client.queries[client.queries.length - 1]
      if (last === undefined) throw new Error('no query recorded')
      return last
    },
  }
  return client
}
