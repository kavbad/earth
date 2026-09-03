/**
 * Privileges and realtime wiring for messaging (ARCHITECTURE §5 conventions; DB_API §2
 * "Realtime"; 0260, 0270, 0280): tables are read-only for members through policies, RPCs are
 * security definer with the pinned search_path and explicit grants, and the four tables are in
 * the `supabase_realtime` publication with a full replica identity where deletes are filtered.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { scalar } from '../admission/fixtures'
import { createTestDb, type TestDb } from '../harness'

const RPCS = [
  'public.messages_list(uuid, uuid, integer)',
  'public.messages_since(uuid, uuid)',
  'public.message_send(uuid, uuid, public.message_type, text, jsonb, uuid)',
  'public.message_edit(uuid, text)',
  'public.message_delete(uuid)',
  'public.message_reaction_toggle(uuid, text)',
  'public.conversation_mark_read(uuid, uuid)',
  'public.conversations_list(timestamptz, integer)',
  'public.conversation_get(uuid)',
  'public.group_invite_join(text)',
  'public.group_leave(uuid)',
] as const

describe('messaging grants and realtime', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
  })

  afterAll(async () => {
    await db.drop()
  })

  it('messages and message_reactions: select for authenticated only; no client writes', async () => {
    for (const table of ['public.messages', 'public.message_reactions']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(await scalar(db, 'has_table_privilege($1, $2, $3)', ['anon', table, privilege]), `anon ${privilege} ${table}`).toBe(false)
        expect(await scalar(db, 'has_table_privilege($1, $2, $3)', ['authenticated', table, privilege]), `authenticated ${privilege} ${table}`).toBe(
          privilege === 'SELECT',
        )
        expect(await scalar(db, 'has_table_privilege($1, $2, $3)', ['service_role', table, privilege]), `service ${privilege} ${table}`).toBe(true)
      }
      const { rows } = await db.sql.query<{ cmd: string; roles: string[] }>(
        `select polcmd as cmd, array(select rolname::text from pg_roles where oid = any (polroles)) as roles from pg_policy where polrelid = $1::regclass`,
        [table],
      )
      expect(rows.map((r) => [r.cmd, r.roles])).toEqual([['r', ['authenticated']]])
    }
  })

  it('every messaging RPC is security definer with the pinned search_path and explicit grants', async () => {
    for (const signature of RPCS) {
      const { rows } = await db.sql.query<{ secdef: boolean; config: string[] | null; volatility: string }>(
        `select prosecdef as secdef, proconfig as config, provolatile as volatility from pg_proc where oid = $1::regprocedure`,
        [signature],
      )
      expect(rows[0]?.secdef, signature).toBe(true)
      expect(rows[0]?.config, signature).toContain('search_path=public, earth, private, pg_temp')
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect(await scalar(db, 'has_function_privilege($1, $2, $3)', [role, signature, 'EXECUTE']), `${role} ${signature}`).toBe(true)
      }
      expect(await scalar(db, 'has_function_privilege($1, $2, $3)', ['public', signature, 'EXECUTE']), `public ${signature}`).toBe(false)
    }
    // Mutations are volatile, reads are stable.
    for (const [signature, volatility] of [
      ['public.messages_list(uuid, uuid, integer)', 's'],
      ['public.messages_since(uuid, uuid)', 's'],
      ['public.message_send(uuid, uuid, public.message_type, text, jsonb, uuid)', 'v'],
      ['public.conversation_mark_read(uuid, uuid)', 'v'],
    ] as const) {
      expect(await scalar(db, 'provolatile from pg_proc where oid = $1::regprocedure', [signature]), signature).toBe(volatility)
    }
  })

  it('messages, message_reactions, conversation_members and conversations are published for realtime', async () => {
    const { rows } = await db.sql.query<{ tablename: string }>(
      `select tablename from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' order by tablename`,
    )
    const published = rows.map((r) => r.tablename)
    for (const table of ['messages', 'message_reactions', 'conversation_members', 'conversations', 'notifications']) {
      expect(published, table).toContain(table)
    }
    // Filtered deletes need the whole old row.
    expect(await scalar(db, `relreplident from pg_class where oid = 'public.messages'::regclass`)).toBe('f')
    expect(await scalar(db, `relreplident from pg_class where oid = 'public.message_reactions'::regclass`)).toBe('f')
    // conversation_members carries conversation_id in its primary key; conversations is filtered by id.
    expect(await scalar(db, `relreplident from pg_class where oid = 'public.conversation_members'::regclass`)).toBe('d')
  })

  it('indexes back every foreign key and the keyset query path', async () => {
    const { rows } = await db.sql.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where schemaname = 'public' and tablename in ('messages', 'message_reactions') order by indexname`,
    )
    const defs = rows.map((r) => r.indexdef)
    expect(defs.some((d) => d.includes('messages_conversation_created_idx') && d.includes('(conversation_id, created_at DESC, id DESC)'))).toBe(true)
    expect(defs.some((d) => d.includes('messages_sender_human_id_idx'))).toBe(true)
    expect(defs.some((d) => d.includes('messages_reply_to_message_id_idx'))).toBe(true)
    expect(defs.some((d) => d.includes('message_reactions_human_id_idx'))).toBe(true)
    expect(defs.some((d) => d.includes('message_reactions_conversation_message_idx'))).toBe(true)
    expect(defs.some((d) => d.includes('messages_client_key') && d.includes('(conversation_id, sender_human_id, client_id)'))).toBe(true)
  })
})
