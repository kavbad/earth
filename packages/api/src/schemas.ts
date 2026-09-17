/**
 * Small schema combinators used by several namespaces.
 */
import { z } from 'zod'

/**
 * Accepts either a bare JSON array or `{ [key]: [...] }` and yields the array. DB_API.md describes
 * some list results as `XDto[]` while RPC authors commonly wrap lists in an object; the client
 * accepts both so neither side has to guess. A JSON `null` (a `jsonb_agg` over no rows without
 * `coalesce`) is an empty list, not a contract error — the polling fallback reads these every 2 s.
 */
export function arrayOrKeyed<T>(item: z.ZodType<T>, key: string): z.ZodType<T[]> {
  const wrapped = z
    .object({ [key]: z.array(item).nullish() })
    .transform((value): T[] => (value[key] as T[] | null | undefined) ?? [])
  const empty = z.null().transform((): T[] => [])
  return z.union([z.array(item), wrapped, empty])
}
