/**
 * Storage buckets and object policies (supabase/migrations/0997_storage_buckets.sql; ARCHITECTURE §5,
 * spec §10, §104).
 *
 * Every photo, video, file, voice note and claim avatar is written to Supabase Storage under
 * `<human_id>/<random>.<ext>` (packages/api `media.upload`), and the only thing standing between one
 * member's key space and another's is the `storage.objects` row level security 0997 installs. Until
 * the shim gave a plain Postgres a `storage` schema (supabase/tests/sql/supabase_shim.sql block 6)
 * that migration hit its own guard and returned, so neither the buckets nor the policies were ever
 * created here and nothing exercised them (audit DOD-02).
 *
 * This file pins both halves: the three buckets with the limits the clients rely on, and the five
 * policies actually deciding, row by row, that the first path segment is the caller's own Human.
 */
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import { createGuest, createHuman, type Human } from '../admission/fixtures'

/** `insufficient_privilege`: what a refused write raises, RLS or missing grant alike. */
const PERMISSION_DENIED = '42501'

/** The ownership comparison every private policy is built on. */
const OWNS_FOLDER = '(storage.foldername(name))[1] = (earth.current_human_id())::text'

interface PolicyRow {
  policyname: string
  cmd: string
  roles: string[]
  qual: string | null
  with_check: string | null
}

describe('storage buckets and object policies (0997)', () => {
  let db: TestDb
  let alice: Human
  let bob: Human
  let guest: { userId: string; as: RoleSpec }
  let claiming: string

  /** Writes one object as `as`; resolves to the stored name or rejects with the database error. */
  async function insertObject(
    as: RoleSpec,
    bucket: string,
    name: string,
  ): Promise<string | undefined> {
    return db.asRole(as, async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `insert into storage.objects (bucket_id, name, owner) values ($1, $2, auth.uid())
         returning name`,
        [bucket, name],
      )
      return rows[0]?.name
    })
  }

  /** Names of the objects in `bucket` this caller can see through the read policies. */
  async function visibleNames(as: RoleSpec, bucket: string): Promise<string[]> {
    return db.asRole(as, async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `select name from storage.objects where bucket_id = $1 order by name`,
        [bucket],
      )
      return rows.map((row) => row.name)
    })
  }

  async function deniedCode(promise: Promise<unknown>): Promise<string | undefined> {
    try {
      await promise
      return undefined
    } catch (error) {
      return error instanceof pg.DatabaseError ? error.code : String(error)
    }
  }

  beforeAll(async () => {
    db = await createTestDb()
    alice = await createHuman(db, { handle: 'alice' })
    bob = await createHuman(db, { handle: 'bob' })
    guest = await createGuest(db)
    // A real credential with no Human yet: earth.current_human_id() is null for it.
    claiming = await db.createAuthUser({ email: 'claiming-storage@example.test' })
  })

  afterAll(async () => {
    await db.drop()
  })

  it('creates the three buckets the clients upload to, with their limits', async () => {
    const { rows } = await db.sql.query<{
      id: string
      public: boolean
      file_size_limit: string
      allowed_mime_types: string[]
    }>(
      `select id, public, file_size_limit::text, allowed_mime_types
         from storage.buckets order by id`,
    )
    expect(rows.map((row) => [row.id, row.public, Number(row.file_size_limit)])).toEqual([
      ['avatars', true, 5_242_880],
      ['media', false, 104_857_600],
      ['voice', false, 26_214_400],
    ])
    const mime = new Map(rows.map((row) => [row.id, row.allowed_mime_types]))
    expect(mime.get('avatars')).toContain('image/jpeg')
    expect(mime.get('media')).toEqual(
      expect.arrayContaining(['image/jpeg', 'video/mp4', 'video/quicktime']),
    )
    expect(mime.get('voice')).toEqual(expect.arrayContaining(['audio/mp4', 'audio/webm']))
  })

  it('enables row level security on storage.objects and installs exactly the five earth policies', async () => {
    const rls = await db.sql.query<{ relrowsecurity: boolean }>(
      `select relrowsecurity from pg_class where oid = 'storage.objects'::regclass`,
    )
    expect(rls.rows[0]?.relrowsecurity).toBe(true)

    const { rows } = await db.sql.query<PolicyRow>(
      `select policyname, cmd, roles::text[] as roles, qual, with_check
         from pg_policies where schemaname = 'storage' and tablename = 'objects'
        order by policyname`,
    )
    expect(rows.map((row) => [row.policyname, row.cmd, row.roles])).toEqual([
      ['earth_avatars_public_read', 'SELECT', ['public']],
      ['earth_owner_delete', 'DELETE', ['authenticated']],
      ['earth_owner_update', 'UPDATE', ['authenticated']],
      ['earth_owner_write', 'INSERT', ['authenticated']],
      ['earth_private_owner_read', 'SELECT', ['authenticated']],
    ])

    // The four private policies all decide on the first path segment being the caller's Human.
    const byName = new Map(rows.map((row) => [row.policyname, row]))
    expect(byName.get('earth_owner_write')?.with_check).toContain(OWNS_FOLDER)
    expect(byName.get('earth_owner_write')?.with_check).toContain(
      'earth.current_human_id() IS NOT NULL',
    )
    expect(byName.get('earth_private_owner_read')?.qual).toContain(OWNS_FOLDER)
    expect(byName.get('earth_owner_update')?.qual).toContain(OWNS_FOLDER)
    expect(byName.get('earth_owner_update')?.with_check).toContain(OWNS_FOLDER)
    expect(byName.get('earth_owner_delete')?.qual).toContain(OWNS_FOLDER)
    expect(byName.get('earth_avatars_public_read')?.qual).toBe("(bucket_id = 'avatars'::text)")
  })

  it('lets a Human write only under its own human id, in every bucket', async () => {
    for (const bucket of ['avatars', 'media', 'voice']) {
      await expect(insertObject(alice.as, bucket, `${alice.humanId}/own.${bucket}`)).resolves.toBe(
        `${alice.humanId}/own.${bucket}`,
      )
      expect(
        await deniedCode(insertObject(alice.as, bucket, `${bob.humanId}/stolen.${bucket}`)),
        `${bucket}: writing into another Human's folder`,
      ).toBe(PERMISSION_DENIED)
    }
    // A key with no folder at all has no owner segment, so nothing can claim it.
    expect(await deniedCode(insertObject(alice.as, 'media', 'loose.jpg'))).toBe(PERMISSION_DENIED)
  })

  it('refuses every caller that is not a Human', async () => {
    expect(await deniedCode(insertObject('visitor', 'media', `${alice.humanId}/v.jpg`))).toBe(
      PERMISSION_DENIED,
    )
    expect(await deniedCode(insertObject(guest.as, 'media', `${alice.humanId}/g.jpg`))).toBe(
      PERMISSION_DENIED,
    )
    expect(
      await deniedCode(insertObject({ userId: claiming }, 'media', `${alice.humanId}/c.jpg`)),
    ).toBe(PERMISSION_DENIED)
  })

  it('shows private objects to their owner only, and avatars to everyone', async () => {
    await insertObject(bob.as, 'media', `${bob.humanId}/bob.jpg`)
    await insertObject(bob.as, 'voice', `${bob.humanId}/bob.m4a`)
    await insertObject(bob.as, 'avatars', `${bob.humanId}/bob-face.jpg`)

    expect(await visibleNames(alice.as, 'media')).toEqual([`${alice.humanId}/own.media`])
    expect(await visibleNames(bob.as, 'media')).toEqual([`${bob.humanId}/bob.jpg`])
    expect(await visibleNames(alice.as, 'voice')).toEqual([`${alice.humanId}/own.voice`])
    expect(await visibleNames('visitor', 'media')).toEqual([])
    expect(await visibleNames(guest.as, 'voice')).toEqual([])

    const avatars = [`${alice.humanId}/own.avatars`, `${bob.humanId}/bob-face.jpg`].sort()
    expect((await visibleNames('visitor', 'avatars')).sort()).toEqual(avatars)
    expect((await visibleNames(alice.as, 'avatars')).sort()).toEqual(avatars)
  })

  it('lets only the owner move or delete an object', async () => {
    const target = `${alice.humanId}/own.media`
    const affected = async (as: RoleSpec, sql: string, params: unknown[]): Promise<number> =>
      db.asRole(as, async (client) => (await client.query(sql, params)).rowCount ?? 0, {
        rollback: true,
      })

    // Another Human's update and delete match no row: the policy hides it from them entirely.
    expect(
      await affected(bob.as, `update storage.objects set metadata = '{}'::jsonb where name = $1`, [
        target,
      ]),
    ).toBe(0)
    expect(await affected(bob.as, `delete from storage.objects where name = $1`, [target])).toBe(0)

    expect(
      await affected(
        alice.as,
        `update storage.objects set metadata = '{}'::jsonb where name = $1`,
        [target],
      ),
    ).toBe(1)
    expect(await affected(alice.as, `delete from storage.objects where name = $1`, [target])).toBe(
      1,
    )

    // Renaming an object out of your own folder is a write into someone else's key space.
    expect(
      await deniedCode(
        affected(alice.as, `update storage.objects set name = $2 where name = $1`, [
          target,
          `${bob.humanId}/moved.jpg`,
        ]),
      ),
    ).toBe(PERMISSION_DENIED)
  })
})
