/**
 * Cross-package contract with the database tier. The `postgres_changes` bindings this package
 * makes (`subscribeConversation`, `subscribeRoom`) only work if the column each filter names
 * exists on the bound table, a filtered DELETE still carries it (`replica identity full`) and the
 * table is in the `supabase_realtime` publication (DB_API §2 "Realtime", §3; ARCHITECTURE §5, §8).
 * Read straight from `supabase/migrations` so a renamed column, a dropped publication entry or a
 * filter on a column that was never added (the `message_reactions.conversation_id` case) fails
 * here rather than in production, where Supabase silently delivers nothing.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { type RoomDto, asConversationId, asRoomId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { REALTIME_SCHEMA, REALTIME_TABLES } from './channel'
import { subscribeConversation } from './conversation'
import { subscribeRoom } from './room'
import { createFakeClock } from './testing/fake-clock'
import { createFakeSupabase } from './testing/fake-supabase'

const MIGRATIONS_DIR = new URL('../../../supabase/migrations/', import.meta.url)

const MIGRATIONS = {
  messages: '0250_messages.sql',
  messagesRealtime: '0280_messages_realtime.sql',
  rooms: '0300_rooms.sql',
  roomsRealtime: '0340_rooms_realtime.sql',
} as const

function migration(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, MIGRATIONS_DIR)), 'utf8')
}

/** Column names of `create table public.<table> ( ... );` in a migration. */
function tableColumns(sql: string, table: string): string[] {
  const header = `create table ${REALTIME_SCHEMA}.${table} (`
  const start = sql.indexOf(header)
  expect(start, header).toBeGreaterThanOrEqual(0)
  const end = sql.indexOf('\n);', start)
  expect(end, `end of ${header}`).toBeGreaterThan(start)
  return sql
    .slice(start + header.length, end)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('--') && !line.startsWith('constraint'))
    .map((line) => line.split(/\s+/)[0] ?? '')
}

/** Tables named by `alter publication supabase_realtime add table public.<t>` (0340) or the 0280 array. */
function publishedTables(sql: string): string[] {
  const direct = [...sql.matchAll(/add table public\.(\w+)/g)].map((m) => m[1] ?? '')
  const arrays = [...sql.matchAll(/array\[([^\]]*)\]/g)].flatMap((m) =>
    [...(m[1] ?? '').matchAll(/'(\w+)'/g)].map((n) => n[1] ?? ''),
  )
  return [...direct, ...arrays]
}

function fullReplicaIdentityTables(sql: string): string[] {
  return [...sql.matchAll(/alter table public\.(\w+) replica identity full;/g)].map(
    (m) => m[1] ?? '',
  )
}

interface Binding {
  readonly table: string
  readonly filter?: string
}

function bindingsOf(channel: {
  postgresBindings: ReadonlyArray<{ filter: { table: string; filter?: string } }>
}): Binding[] {
  return channel.postgresBindings.map(({ filter }) =>
    filter.filter === undefined
      ? { table: filter.table }
      : { table: filter.table, filter: filter.filter },
  )
}

/** The column a `column=eq.value` filter names. */
function filterColumn(binding: Binding): string {
  const column = /^(\w+)=eq\./.exec(binding.filter ?? '')?.[1]
  expect(column, `filter of ${binding.table}: ${binding.filter ?? '(none)'}`).toBeDefined()
  return column ?? ''
}

const CONVERSATION_ID = asConversationId('11111111-1111-4111-8111-111111111111')
const ROOM_ID = asRoomId('22222222-2222-4222-8222-222222222222')

function conversationBindings(): Binding[] {
  const supabase = createFakeSupabase()
  const subscription = subscribeConversation({
    supabase,
    conversationId: CONVERSATION_ID,
    fetchSince: async () => [],
    onMessage: () => undefined,
    onReaction: () => undefined,
    clock: createFakeClock(),
  })
  const bindings = bindingsOf(supabase.latest())
  subscription.unsubscribe()
  return bindings
}

function roomBindings(): Binding[] {
  const supabase = createFakeSupabase()
  const subscription = subscribeRoom({
    supabase,
    roomId: ROOM_ID,
    fetchState: () => new Promise<RoomDto>(() => undefined),
    onRoom: () => undefined,
    clock: createFakeClock(),
  })
  const bindings = bindingsOf(supabase.latest())
  subscription.unsubscribe()
  return bindings
}

describe('realtime bindings against supabase/migrations', () => {
  const messagesSql = migration(MIGRATIONS.messages)
  const messagesRealtimeSql = migration(MIGRATIONS.messagesRealtime)
  const roomsSql = migration(MIGRATIONS.rooms)
  const roomsRealtimeSql = migration(MIGRATIONS.roomsRealtime)

  const columns: Record<string, string[]> = {
    [REALTIME_TABLES.messages]: tableColumns(messagesSql, REALTIME_TABLES.messages),
    [REALTIME_TABLES.messageReactions]: tableColumns(messagesSql, REALTIME_TABLES.messageReactions),
    [REALTIME_TABLES.rooms]: tableColumns(roomsSql, REALTIME_TABLES.rooms),
    [REALTIME_TABLES.roomParticipants]: tableColumns(roomsSql, REALTIME_TABLES.roomParticipants),
  }
  const published = [...publishedTables(messagesRealtimeSql), ...publishedTables(roomsRealtimeSql)]
  const fullIdentity = [
    ...fullReplicaIdentityTables(messagesRealtimeSql),
    ...fullReplicaIdentityTables(roomsRealtimeSql),
  ]

  it('parses the table definitions it relies on', () => {
    expect(columns[REALTIME_TABLES.messages]).toContain('id')
    expect(columns[REALTIME_TABLES.messageReactions]).toContain('message_id')
    expect(columns[REALTIME_TABLES.rooms]).toContain('id')
    expect(columns[REALTIME_TABLES.roomParticipants]).toContain('room_id')
  })

  it('message_reactions carries the denormalized conversation_id the reaction filter needs (0250)', () => {
    expect(columns[REALTIME_TABLES.messageReactions]).toContain('conversation_id')
    // Set by trigger from the message, so a client never has to supply it.
    expect(messagesSql).toMatch(/create trigger message_reactions_before_insert/)
  })

  it.each([
    ['subscribeConversation', conversationBindings],
    ['subscribeRoom', roomBindings],
  ])('%s filters every binding on a column of the bound, published table', (_name, bindings) => {
    const list = bindings()
    expect(list.length).toBeGreaterThan(0)
    for (const binding of list) {
      const tableColumnList = columns[binding.table]
      expect(tableColumnList, `known table ${binding.table}`).toBeDefined()
      expect(tableColumnList, `${binding.table}.${filterColumn(binding)}`).toContain(
        filterColumn(binding),
      )
      expect(published, `${binding.table} in supabase_realtime`).toContain(binding.table)
      // A filtered DELETE only carries the replica identity; the filter column must be in it.
      expect(fullIdentity, `${binding.table} replica identity full`).toContain(binding.table)
    }
  })

  it('reads message rows with the columns 0250 defines', () => {
    const messageColumns = columns[REALTIME_TABLES.messages] ?? []
    for (const column of [
      'id',
      'conversation_id',
      'sender_human_id',
      'type',
      'text',
      'payload',
      'reply_to_message_id',
      'created_at',
      'edited_at',
      'deleted_at',
      'client_id',
    ]) {
      expect(messageColumns, column).toContain(column)
    }
    const reactionColumns = columns[REALTIME_TABLES.messageReactions] ?? []
    for (const column of ['message_id', 'human_id', 'reaction', 'conversation_id']) {
      expect(reactionColumns, column).toContain(column)
    }
  })
})
