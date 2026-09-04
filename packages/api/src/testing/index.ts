/**
 * `@earth/api/testing` — in-memory fakes (supabase, fetch), a client harness and wire-shaped DTO
 * fixtures so packages and apps can test against `EarthClient` without a network or a database.
 */
export * from './fake-supabase'
export * from './fake-fetch'
export * from './harness'
export * as fixtures from './fixtures'
