import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ENUM_REGISTRY, POSTGRES_ENUM_NAMES } from './domain'
import { createTestDb, type TestDb } from './harness'

interface EnumRow {
  name: string
  values: string[]
}

describe('enum parity (ARCHITECTURE §5)', () => {
  let db: TestDb
  let actual: Map<string, string[]>

  beforeAll(async () => {
    db = await createTestDb()
    const { rows } = await db.sql.query<EnumRow>(
      `select t.typname as name,
              array_agg(e.enumlabel::text order by e.enumsortorder) as values
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
         join pg_enum e on e.enumtypid = t.oid
        where n.nspname = 'public' and t.typtype = 'e'
        group by t.typname`,
    )
    actual = new Map(rows.map((row) => [row.name, row.values]))
  })

  afterAll(async () => {
    await db.drop()
  })

  it('defines every ENUM_REGISTRY type in public', () => {
    for (const name of POSTGRES_ENUM_NAMES) {
      expect(actual.has(name), `missing enum type public.${name}`).toBe(true)
    }
  })

  it('defines no enum type in public outside ENUM_REGISTRY (the two lists are identical)', () => {
    const registry = new Set<string>(POSTGRES_ENUM_NAMES)
    const unmirrored = [...actual.keys()].filter((name) => !registry.has(name)).sort()
    expect(
      unmirrored,
      'every public enum type must be mirrored in packages/domain/src/enums.ts ENUM_REGISTRY',
    ).toEqual([])
    expect([...actual.keys()].sort()).toEqual([...POSTGRES_ENUM_NAMES].sort())
  })

  it.each(Object.entries(ENUM_REGISTRY))('%s has identical ordered values', (name, values) => {
    expect(actual.get(name)).toEqual([...values])
  })

  it('accepts every registry value as a literal of its type', async () => {
    for (const [name, values] of Object.entries(ENUM_REGISTRY)) {
      const { rows } = await db.sql.query<{ ok: boolean }>(
        `select count(*) = $2 as ok
           from unnest($1::text[]) as v(label)
          where v.label::public.${name}::text = v.label`,
        [[...values], values.length],
      )
      expect(rows[0]?.ok, name).toBe(true)
    }
  })

  it('has no duplicate labels within a registry type', () => {
    for (const [name, values] of Object.entries(ENUM_REGISTRY)) {
      expect(new Set(values).size, name).toBe(values.length)
    }
  })
})
