/**
 * @earth/config — zod-validated environment (public + server), feature flag keys and constants.
 *
 * See docs/architecture/ARCHITECTURE.md §12 and §14. This file is the single public entry point
 * of the package.
 */
export const PACKAGE_NAME = '@earth/config' as const

export * from './constants'
export * from './env'
export * from './flags'
