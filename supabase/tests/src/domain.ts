/**
 * Domain constants the database tests compare against.
 *
 * The workspace uses pnpm's hoisted linker and this package declares no `@earth/domain` dependency
 * (declaring one requires a lockfile update), so the enum registry is imported by relative path.
 * Replace with `from '@earth/domain'` once the workspace dependency is declared and installed.
 */
export { ENUM_REGISTRY, POSTGRES_ENUM_NAMES } from '../../../packages/domain/src/enums'
export { EARTH_ERROR_CODES } from '../../../packages/domain/src/errors'
