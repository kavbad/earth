/**
 * @earth/api — EarthClient: typed wrapper over supabase-js RPC/select/storage and fetch to the
 * server tier (ARCHITECTURE §7). Single public entry point of the package; test fakes and DTO
 * fixtures live under `@earth/api/testing`.
 */
export const PACKAGE_NAME = '@earth/api' as const

export * from './types'
export * from './rpc'
export * from './dto'
export * from './schemas'
export * from './manifest'
export * from './transport'
export * from './client'
export * from './realtimeFactories'
export * from './namespaces/identity'
export * from './namespaces/groups'
export * from './namespaces/conversations'
export * from './namespaces/rooms'
export * from './namespaces/discovery'
export * from './namespaces/posts'
export * from './namespaces/social'
export * from './namespaces/notifications'
export * from './namespaces/telemetry'
