/**
 * Per-test-file database harness (ARCHITECTURE §15).
 *
 *   const db = await createTestDb()          // clone of the migrated template
 *   const userId = await db.createAuthUser() // row in auth.users
 *   await db.rpc('group_create', { name: 'Weekend Crew' }, { userId })
 *   await db.expectError(db.rpc('group_get', { group_id }, 'visitor'), 'not_authenticated')
 *   await db.drop()
 *
 * Role impersonation mirrors PostgREST: `set local role anon|authenticated|service_role` plus the
 * `request.jwt.claims` setting that auth.uid() / auth.jwt() / earth.jwt_claims() read. Always go
 * through asRole/rpc for caller-facing behavior; `sql` is the superuser and, with no JWT set, counts
 * as the service (earth.is_service_role()).
 */
import pg from 'pg'
import { inject } from 'vitest'

import { quoteIdentifier } from '../../../scripts/db/migrate-core'
import {
  PROVIDED_ADMIN_URL,
  PROVIDED_TEMPLATE,
  TEMPLATE_DATABASE,
  adminUrlFromEnv,
  connectAdmin,
  createScratchDatabase,
  databaseUrl,
  dropDatabase,
  scratchDatabaseName,
} from './template'

/** Database roles PostgREST switches to (Supabase API roles). */
export const DB_ROLES = {
  anon: 'anon',
  authenticated: 'authenticated',
  service_role: 'service_role',
} as const
export type DbRole = (typeof DB_ROLES)[keyof typeof DB_ROLES]

/** A Supabase auth user (Guest when `isAnonymous`, otherwise a real credential). */
export interface AuthUserSpec {
  userId: string
  isAnonymous?: boolean
  /** Extra JWT claims merged over the generated ones. */
  claims?: Record<string, unknown>
}

/** Who runs a statement: a visitor (anon key), the service role, or a specific auth user. */
export type RoleSpec = 'visitor' | 'service' | AuthUserSpec

export interface JwtClaims {
  role: DbRole
  sub?: string
  aud?: string
  is_anonymous?: boolean
  [claim: string]: unknown
}

export interface AsRoleOptions {
  /** Roll the transaction back instead of committing it (default: commit). */
  rollback?: boolean
}

export interface CreateAuthUserInput {
  email?: string
  phone?: string
  isAnonymous?: boolean
}

export type RpcArgs = Record<string, unknown>

export interface CreateTestDbOptions {
  adminUrl?: string
  template?: string
}

/** Client handed to `asRole` callbacks: a pooled connection inside the impersonating transaction. */
export type RoleClient = pg.PoolClient

export interface TestDb {
  /** Scratch database name (`earth_test_scratch_...`). */
  readonly name: string
  readonly url: string
  /** Superuser connection (no JWT, counts as the service). */
  readonly sql: pg.Client
  /** Runs `fn` in a transaction as the given caller, committing unless `rollback` is set. */
  asRole<T>(
    as: RoleSpec,
    fn: (client: RoleClient) => Promise<T>,
    options?: AsRoleOptions,
  ): Promise<T>
  /** Inserts an auth.users row and returns its id. */
  createAuthUser(input?: CreateAuthUserInput): Promise<string>
  /**
   * `select * from public.<name>(<arg> => $n, ...)` as the caller. A single-column single-row result
   * (the usual `returns jsonb`) is returned unwrapped; otherwise the rows are returned.
   */
  rpc<T = unknown>(name: string, args: RpcArgs, as: RoleSpec): Promise<T>
  /** Asserts the promise rejects with a P0001 error whose message is exactly `code`. */
  expectError(promise: Promise<unknown>, code: string): Promise<pg.DatabaseError>
  /** Ends connections and drops the scratch database. Idempotent. */
  drop(): Promise<void>
}

export const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/

export function assertIdentifier(value: string, what: string): void {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`${what} must be a snake_case SQL identifier, got "${value}"`)
  }
}

export function roleFor(as: RoleSpec): DbRole {
  if (as === 'visitor') return DB_ROLES.anon
  if (as === 'service') return DB_ROLES.service_role
  return DB_ROLES.authenticated
}

/** JWT claims PostgREST would expose for this caller. */
export function claimsFor(as: RoleSpec): JwtClaims {
  if (as === 'visitor') return { role: DB_ROLES.anon }
  if (as === 'service') return { role: DB_ROLES.service_role }
  return {
    ...as.claims,
    role: DB_ROLES.authenticated,
    aud: 'authenticated',
    sub: as.userId,
    is_anonymous: as.isAnonymous ?? false,
  }
}

/** Unwraps `select * from f(...)`: one column and one row → the value; otherwise the rows. */
export function unwrapRpcResult(result: pg.QueryResult): unknown {
  const field = result.fields[0]
  if (result.fields.length === 1 && field !== undefined) {
    const column = field.name
    const rows = result.rows as Array<Record<string, unknown>>
    if (rows.length === 1) return rows[0]?.[column]
    return rows.map((row) => row[column])
  }
  return result.rows
}

function describeError(error: unknown): string {
  if (error instanceof pg.DatabaseError) return `${error.message} (sqlstate ${error.code ?? '?'})`
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

function resolveContext(options: CreateTestDbOptions): { adminUrl: string; template: string } {
  let injectedAdminUrl: string | undefined
  let injectedTemplate: string | undefined
  try {
    injectedAdminUrl = inject(PROVIDED_ADMIN_URL)
    injectedTemplate = inject(PROVIDED_TEMPLATE)
  } catch {
    // Outside a vitest worker (for example a script reusing the harness): fall back to the environment.
  }
  return {
    adminUrl: options.adminUrl ?? injectedAdminUrl ?? adminUrlFromEnv(),
    template: options.template ?? injectedTemplate ?? TEMPLATE_DATABASE,
  }
}

const ERROR_CODE_RAISE_EXCEPTION = 'P0001'

export async function createTestDb(options: CreateTestDbOptions = {}): Promise<TestDb> {
  const { adminUrl, template } = resolveContext(options)
  const name = scratchDatabaseName()

  const admin = await connectAdmin(adminUrl)
  try {
    await createScratchDatabase(admin, name, template)
  } finally {
    await admin.end()
  }

  const url = databaseUrl(adminUrl, name)
  const sql = new pg.Client({ connectionString: url })
  await sql.connect()
  const pool = new pg.Pool({ connectionString: url, max: 4 })
  let dropped = false

  const asRole: TestDb['asRole'] = async (as, fn, roleOptions = {}) => {
    const client = await pool.connect()
    try {
      await client.query('begin')
      try {
        await client.query(`set local role ${roleFor(as)}`)
        await client.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify(claimsFor(as)),
        ])
        const result = await fn(client)
        await client.query(roleOptions.rollback === true ? 'rollback' : 'commit')
        return result
      } catch (error) {
        await client.query('rollback').catch(() => undefined)
        throw error
      }
    } finally {
      client.release()
    }
  }

  const createAuthUser: TestDb['createAuthUser'] = async (input = {}) => {
    const { rows } = await sql.query<{ id: string }>(
      `insert into auth.users (id, aud, role, email, phone, raw_app_meta_data, raw_user_meta_data,
                               is_anonymous, created_at, updated_at)
       values (gen_random_uuid(), 'authenticated', 'authenticated', $1, $2, '{}'::jsonb, '{}'::jsonb,
               $3, now(), now())
       returning id`,
      [input.email ?? null, input.phone ?? null, input.isAnonymous ?? false],
    )
    const id = rows[0]?.id
    if (id === undefined) throw new Error('auth.users insert returned no id')
    return id
  }

  const rpc: TestDb['rpc'] = async <T>(fnName: string, args: RpcArgs, as: RoleSpec) => {
    assertIdentifier(fnName, 'rpc name')
    const keys = Object.keys(args)
    for (const key of keys) assertIdentifier(key, `rpc argument ${key}`)
    const placeholders = keys.map((key, i) => `${quoteIdentifier(key)} => $${i + 1}`).join(', ')
    const text = `select * from public.${quoteIdentifier(fnName)}(${placeholders})`
    const values = keys.map((key) => args[key])
    return asRole(as, async (client) => unwrapRpcResult(await client.query(text, values)) as T)
  }

  const expectError: TestDb['expectError'] = async (promise, code) => {
    let failure: unknown
    let succeeded = false
    try {
      await promise
      succeeded = true
    } catch (error) {
      failure = error
    }
    if (succeeded) throw new Error(`expected error "${code}" but the call succeeded`)
    if (!(failure instanceof pg.DatabaseError)) {
      throw new Error(
        `expected error "${code}" but got a non-Postgres error: ${describeError(failure)}`,
      )
    }
    if (failure.message !== code || failure.code !== ERROR_CODE_RAISE_EXCEPTION) {
      throw new Error(`expected error "${code}" but got ${describeError(failure)}`)
    }
    return failure
  }

  const drop: TestDb['drop'] = async () => {
    if (dropped) return
    dropped = true
    await sql.end().catch(() => undefined)
    await pool.end().catch(() => undefined)
    const dropper = await connectAdmin(adminUrl)
    try {
      await dropDatabase(dropper, name)
    } finally {
      await dropper.end()
    }
  }

  return { name, url, sql, asRole, createAuthUser, rpc, expectError, drop }
}
