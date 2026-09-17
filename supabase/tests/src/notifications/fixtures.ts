/**
 * Shared fixtures for the notifications tests (Milestone 2/4 support; DB_API §6; ARCHITECTURE §11).
 * Notification rows are inserted directly (explicit priorities and timestamps make ordering tests
 * deterministic); everything caller-facing goes through the RPCs. Re-exports the admission
 * fixtures the tests build on.
 */
import {
  NotificationsPageDtoSchema,
  type NotificationPriority,
  type NotificationsPageDto,
  type NotificationType,
} from '@earth/domain'
import { randomUUID } from 'node:crypto'

import type { RoleSpec, TestDb } from '../harness'
import type { Human } from '../admission/fixtures'

export {
  addMember,
  befriend,
  block,
  count,
  createGroup,
  createGuest,
  createHuman,
  createUnclaimed,
  notificationsFor,
  scalar,
  type GroupFixture,
  type Human,
} from '../admission/fixtures'

export const PERMISSION_DENIED = '42501'

export interface InsertNotificationInput {
  recipient: Human
  type: NotificationType
  actor?: Human | null
  objectType?: 'human' | 'group' | 'conversation' | 'message' | 'room' | 'post'
  objectId?: string
  payload?: Record<string, unknown>
  /** Defaults to the domain mapping for the type (earth.notification_priority_for). */
  priority?: NotificationPriority
  createdAt?: string | Date
  readAt?: string | Date | null
  pushSentAt?: string | Date | null
}

const toIso = (value: string | Date | null | undefined): string | null =>
  value === null || value === undefined ? null : new Date(value).toISOString()

/** Inserts a notification row as the service and returns its id. */
export async function insertNotification(
  db: TestDb,
  input: InsertNotificationInput,
): Promise<string> {
  const actor = input.actor === undefined ? null : input.actor
  const { rows } = await db.sql.query<{ id: string }>(
    `insert into public.notifications
       (recipient_human_id, type, actor_human_id, object_type, object_id, payload, priority, created_at, read_at, push_sent_at)
     values ($1, $2::earth.notification_type, $3, $4, $5, $6::jsonb,
             coalesce($7::public.notification_priority, earth.notification_priority_for($2::earth.notification_type::text)),
             coalesce($8::timestamptz, now()), $9::timestamptz, $10::timestamptz)
     returning id`,
    [
      input.recipient.humanId,
      input.type,
      actor?.humanId ?? null,
      input.objectType ?? 'human',
      input.objectId ?? actor?.humanId ?? input.recipient.humanId,
      JSON.stringify(input.payload ?? { name: actor?.displayName ?? 'Someone' }),
      input.priority ?? null,
      toIso(input.createdAt),
      toIso(input.readAt),
      toIso(input.pushSentAt),
    ],
  )
  const id = rows[0]?.id
  if (id === undefined) throw new Error('notifications insert returned no id')
  return id
}

export interface PresenceInput {
  lastActiveAt: string | Date
  activeConversationId?: string | null
  activeRoomId?: string | null
  platform?: 'ios' | 'android' | 'web' | null
}

/** Upserts the Human's presence row directly (what presence_ping would have written). */
export async function setPresence(db: TestDb, human: Human, input: PresenceInput): Promise<void> {
  await db.sql.query(
    `insert into public.human_presence (human_id, last_active_at, active_conversation_id, active_room_id, platform)
     values ($1, $2::timestamptz, $3, $4, $5)
     on conflict on constraint human_presence_pkey do update
       set last_active_at = excluded.last_active_at,
           active_conversation_id = excluded.active_conversation_id,
           active_room_id = excluded.active_room_id,
           platform = excluded.platform`,
    [
      human.humanId,
      toIso(input.lastActiveAt),
      input.activeConversationId ?? null,
      input.activeRoomId ?? null,
      input.platform ?? null,
    ],
  )
}

/** Registers a push token through the RPC (own row, Human only). */
export async function registerPushToken(
  db: TestDb,
  human: Human,
  token: string,
  platform: 'ios' | 'android' | 'web' = 'ios',
): Promise<void> {
  await db.rpc('push_token_register', { token, platform }, human.as)
}

export async function directConversation(db: TestDb, a: Human, b: Human): Promise<string> {
  const conversation = await db.rpc<{ id: string }>(
    'conversation_direct_get_or_create',
    { other_human_id: b.humanId },
    a.as,
  )
  return conversation.id
}

/** Sends a text message through the RPC and returns the message id. */
export async function sendMessage(
  db: TestDb,
  sender: Human,
  conversationId: string,
  text: string,
): Promise<string> {
  const message = await db.rpc<{ id: string }>(
    'message_send',
    { conversation_id: conversationId, client_id: randomUUID(), type: 'text', text },
    sender.as,
  )
  return message.id
}

/** `notifications_list` as the caller, validated against the DTO. */
export async function listNotifications(
  db: TestDb,
  as: RoleSpec,
  args: { cursor?: string | null; limit?: number | null } = {},
): Promise<NotificationsPageDto> {
  const page = await db.rpc(
    'notifications_list',
    { cursor: args.cursor ?? null, limit: args.limit ?? null },
    as,
  )
  return NotificationsPageDtoSchema.parse(page)
}

/** Every page of the caller's list, following `nextCursor` until it is null. */
export async function listAllNotifications(
  db: TestDb,
  as: RoleSpec,
  limit: number,
): Promise<NotificationsPageDto['notifications']> {
  const items: NotificationsPageDto['notifications'] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 100; guard += 1) {
    const page: NotificationsPageDto = await listNotifications(db, as, { cursor, limit })
    items.push(...page.notifications)
    if (page.nextCursor === null) return items
    cursor = page.nextCursor
  }
  throw new Error('pagination did not terminate')
}

/** ISO timestamp `seconds` from now (negative for the past). */
export function secondsFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

export interface UnsentRow {
  id: string
  recipientHumanId: string
  type: string
  priority: string
  actorHumanId: string | null
  objectType: string
  objectId: string
  payload: Record<string, unknown>
  createdAt: string
  pushTokens: Array<{ token: string; platform: string }>
  presence: {
    lastActiveAt: string
    activeConversationId: string | null
    activeRoomId: string | null
  } | null
}

export async function unsent(db: TestDb, limit: number | null = null): Promise<UnsentRow[]> {
  return db.rpc<UnsentRow[]>('notifications_unsent', { limit }, 'service')
}

export async function pushSentAt(db: TestDb, id: string): Promise<string | null> {
  const { rows } = await db.sql.query<{ push_sent_at: Date | null }>(
    'select push_sent_at from public.notifications where id = $1',
    [id],
  )
  const value = rows[0]?.push_sent_at ?? null
  return value === null ? null : value.toISOString()
}

export async function readAt(db: TestDb, id: string): Promise<string | null> {
  const { rows } = await db.sql.query<{ read_at: Date | null }>(
    'select read_at from public.notifications where id = $1',
    [id],
  )
  const value = rows[0]?.read_at ?? null
  return value === null ? null : value.toISOString()
}
