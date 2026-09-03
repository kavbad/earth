/**
 * @earth/domain — enums, branded ids, error codes, DTO zod schemas and pure domain logic.
 *
 * Single public entry point of the package (ARCHITECTURE §2/§3). Feed ranking (`./feed`) and
 * participant-aware naming (`./rooms`) are added by later changes and re-exported from here.
 */
export const PACKAGE_NAME = '@earth/domain' as const

export * from './enums'
export * from './ids'
export * from './errors'
export * from './constants'
export * from './audience'
export * from './handle'
export * from './activities'
export * from './commercial'
export * from './identity'
export * from './dto'
export * from './feed'
export * from './rooms'
export * from './social'
export * from './notifications'
export * from './invites'
