/**
 * DTO schemas — the wire contract between the database tier, the server tier and clients.
 *
 * Conventions:
 * - Every key is camelCase. RPCs build their `jsonb` result with the same camelCase keys
 *   (`jsonb_build_object('humanId', ...)`), so `@earth/api` can parse RPC results and server
 *   JSON with one schema per method. Postgres enum values stay snake_case (they are values).
 * - Timestamps are ISO 8601 strings with offset (`to_jsonb(timestamptz)`), never epoch numbers.
 * - Absent-vs-null: result fields are `null` when empty; only optional *input* fields may be omitted.
 * - `XDtoSchema` is the zod schema, `XDto` the inferred type. `XInputSchema` / `XInput` are inputs.
 * - Unknown keys are stripped on parse, so adding a field server-side never breaks older clients.
 */
export * from './common'
export * from './flags'
export * from './claim'
export * from './identity'
export * from './groups'
export * from './conversations'
export * from './rooms'
export * from './geo'
export * from './posts'
export * from './feed'
export * from './notifications'
export * from './search'
export * from './safety'
export * from './social'
