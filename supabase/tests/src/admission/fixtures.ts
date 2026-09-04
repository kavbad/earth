/**
 * Shared fixtures for the admission (Milestone 1) database tests: Humans in every state, social
 * edges, groups and settings, created with direct SQL for speed. Flows under test go through RPCs.
 */
import pg from 'pg'

import type { RoleSpec, TestDb } from '../harness'

export const PERMISSION_DENIED = '42501'

export interface Human {
  userId: string
  humanId: string
  handle: string
  displayName: string
  as: RoleSpec
}

export interface CreateHumanOptions {
  handle: string
  displayName?: string
  visibility?: 'public' | 'limited' | 'hidden'
  status?: 'active' | 'pending' | 'restricted' | 'suspended'
  /** Create the public identity (default true; pending Humans may not have one yet). */
  identity?: boolean
  email?: string
}

let counter = 0
export const uniqueEmail = (): string => `h${Date.now()}-${(counter += 1)}@example.test`

/** An auth user plus a Human row (active unless `status` says otherwise), with an identity. */
export async function createHuman(db: TestDb, options: CreateHumanOptions): Promise<Human> {
  const status = options.status ?? 'active'
  const displayName = options.displayName ?? options.handle
  const userId = await db.createAuthUser({ email: options.email ?? uniqueEmail() })
  const { rows } = await db.sql.query<{ id: string }>(
    `insert into public.humans (status, human_pass_status, auth_user_id, claimed_at, last_active_at)
     values ($1::public.human_status, 'verified', $2, case when $1 = 'pending' then null else now() end, now())
     returning id`,
    [status, userId],
  )
  const humanId = rows[0]?.id
  if (humanId === undefined) throw new Error('humans insert returned no id')
  await db.sql.query(
    `insert into public.auth_identities (human_id, provider, provider_subject, verified_at)
     values ($1, 'supabase', $2, now())`,
    [humanId, userId],
  )
  if (options.identity !== false) {
    await db.sql.query(
      `insert into public.public_identities (human_id, display_name, handle, profile_visibility)
       values ($1, $2, $3, $4::public.profile_visibility)`,
      [humanId, displayName, options.handle, options.visibility ?? 'public'],
    )
  }
  return { userId, humanId, handle: options.handle, displayName, as: { userId } }
}

/** An anonymous Supabase user (Guest credential). */
export async function createGuest(db: TestDb): Promise<{ userId: string; as: RoleSpec }> {
  const userId = await db.createAuthUser({ isAnonymous: true })
  return { userId, as: { userId, isAnonymous: true } }
}

/** A real credential that has not started a claim (no Human row). */
export async function createUnclaimed(db: TestDb): Promise<{ userId: string; as: RoleSpec }> {
  const userId = await db.createAuthUser({ email: uniqueEmail() })
  return { userId, as: { userId } }
}

export async function befriend(db: TestDb, a: Human, b: Human): Promise<void> {
  await db.sql.query(
    `insert into public.relationships (source_human_id, target_human_id, type)
     values ($1, $2, 'friend'), ($2, $1, 'friend')
     on conflict on constraint relationships_source_target_type_key do nothing`,
    [a.humanId, b.humanId],
  )
}

export async function relate(
  db: TestDb,
  source: Human,
  target: Human,
  type: 'follow' | 'friend_pending' | 'familiar_private',
): Promise<void> {
  await db.sql.query(
    `insert into public.relationships (source_human_id, target_human_id, type)
     values ($1, $2, $3::public.relationship_type)
     on conflict on constraint relationships_source_target_type_key do nothing`,
    [source.humanId, target.humanId, type],
  )
}

export async function block(db: TestDb, blocker: Human, blocked: Human): Promise<void> {
  await db.sql.query(
    `insert into public.blocks (blocker_human_id, blocked_human_id) values ($1, $2)
     on conflict on constraint blocks_pkey do nothing`,
    [blocker.humanId, blocked.humanId],
  )
}

export interface GroupFixture {
  groupId: string
  conversationId: string
}

/** A group created through the RPC by `owner` (owner membership + conversation). */
export async function createGroup(
  db: TestDb,
  owner: Human,
  name: string | null = 'Weekend Crew',
): Promise<GroupFixture> {
  const group = await db.rpc<{ id: string; conversationId: string }>(
    'group_create',
    { name },
    owner.as,
  )
  return { groupId: group.id, conversationId: group.conversationId }
}

/** Adds an active membership (and conversation membership) directly. */
export async function addMember(
  db: TestDb,
  group: GroupFixture,
  human: Human,
  role: 'owner' | 'moderator' | 'member' = 'member',
): Promise<void> {
  await db.sql.query(
    `insert into public.group_members (group_id, human_id, role, status)
     values ($1, $2, $3::public.group_member_role, 'active')
     on conflict on constraint group_members_pkey do update
       set role = excluded.role, status = 'active', left_at = null`,
    [group.groupId, human.humanId, role],
  )
  await db.sql.query(
    `insert into public.conversation_members (conversation_id, human_id) values ($1, $2)
     on conflict on constraint conversation_members_pkey do nothing`,
    [group.conversationId, human.humanId],
  )
}

/** A plaintext invite token created through the RPC by `creator`. */
export async function createInvite(
  db: TestDb,
  group: GroupFixture,
  creator: Human,
  options: { expiresInSeconds?: number | null; maxUses?: number | null } = {},
): Promise<{ token: string; inviteId: string; expiresAt: string | null }> {
  return db.rpc(
    'group_invite_create',
    {
      group_id: group.groupId,
      expires_in_seconds: options.expiresInSeconds ?? null,
      max_uses: options.maxUses ?? null,
    },
    creator.as,
  )
}

export async function setSetting(db: TestDb, key: string, value: string): Promise<void> {
  await db.sql.query(
    `insert into public.app_settings (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, value],
  )
}

export async function setFlag(db: TestDb, key: string, enabled: boolean): Promise<void> {
  await db.sql.query(
    `insert into public.feature_flags (key, enabled) values ($1, $2)
     on conflict (key) do update set enabled = excluded.enabled, updated_at = now()`,
    [key, enabled],
  )
}

/** Inserts an area row (centroid only) and returns its id. */
export async function createArea(
  db: TestDb,
  options: {
    name: string
    slug: string
    type: 'neighborhood' | 'city' | 'region' | 'country'
    parentAreaId?: string | null
    lat?: number
    lng?: number
  },
): Promise<string> {
  const { rows } = await db.sql.query<{ id: string }>(
    `insert into public.areas (type, name, slug, parent_area_id, centroid)
     values ($1::public.area_type, $2, $3, $4, st_setsrid(st_makepoint($5, $6), 4326))
     returning id`,
    [
      options.type,
      options.name,
      options.slug,
      options.parentAreaId ?? null,
      options.lng ?? -122.42,
      options.lat ?? 37.77,
    ],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('areas insert returned no id')
  return id
}

/** `scalar(db, "status from public.humans where id = $1")` or a full `select ...` statement. */
export async function scalar<T>(db: TestDb, text: string, values: unknown[] = []): Promise<T> {
  const body = /^\s*select\s/i.test(text) ? text : `select ${text}`
  const { rows } = await db.sql.query<{ v: T }>(`select (${body}) as v`, values)
  return rows[0]?.v as T
}

export async function count(db: TestDb, table: string, where = 'true', values: unknown[] = []) {
  return Number(await scalar<string>(db, `select count(*) from ${table} where ${where}`, values))
}

export function isPermissionDenied(error: unknown): boolean {
  return error instanceof pg.DatabaseError && error.code === PERMISSION_DENIED
}

export async function notificationsFor(
  db: TestDb,
  recipient: Human,
): Promise<
  Array<{ type: string; actor_human_id: string | null; priority: string; payload: unknown }>
> {
  const { rows } = await db.sql.query(
    `select type::text as type, actor_human_id, priority::text as priority, payload
       from public.notifications where recipient_human_id = $1 order by created_at, type`,
    [recipient.humanId],
  )
  return rows as Array<{
    type: string
    actor_human_id: string | null
    priority: string
    payload: unknown
  }>
}
