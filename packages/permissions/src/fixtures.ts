/**
 * Shared permission fixtures (DB_API §11). `packages/permissions/fixtures/<object>.json` is the
 * single source of truth for permission cases: this package asserts `canViewObject` (and the join
 * / send probes) against every case, and `supabase/tests/src/authz/permissions-fixtures.test.ts`
 * materializes the same cases in Postgres and asserts the RLS / RPC outcome.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { MediaStateSchema, RoomVisibilitySchema } from '@earth/domain'
import { z } from 'zod'

import {
  DEFAULT_PERMISSION_FLAGS,
  EarthErrorCodeSchema,
  PermissionFlagsSchema,
  VIEWABLE_OBJECT_TYPES,
  ViewableObjectSchema,
  ViewableObjectTypeSchema,
  ViewerSchema,
  type PermissionFlags,
  type ViewableObject,
  type ViewableObjectType,
  type Viewer,
} from './types'

/** Absolute path of the fixtures directory. */
export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url))

/** `room` fixtures: what `canJoinRoom` / `room_join` must answer for the case. */
export const FixtureJoinProbeSchema = z.object({
  mediaState: MediaStateSchema,
  consentLevel: RoomVisibilitySchema,
  expect: z.boolean(),
  /** The error code when `expect` is `false`, else `null`. */
  reason: EarthErrorCodeSchema.nullable(),
  /** `request` policy seating the viewer as `waiting`. */
  requiresApproval: z.boolean().optional(),
})
export type FixtureJoinProbe = z.infer<typeof FixtureJoinProbeSchema>

/** `conversation` fixtures: what `canSendMessage` / `message_send` must answer. */
export const FixtureSendProbeSchema = z.object({
  expect: z.boolean(),
  reason: EarthErrorCodeSchema.nullable(),
})
export type FixtureSendProbe = z.infer<typeof FixtureSendProbeSchema>

export const FixtureCaseSchema = z.object({
  name: z.string().min(1),
  viewer: ViewerSchema,
  /** The object without its `type` (the file's `object` field supplies it). */
  object: z.record(z.string(), z.unknown()),
  /** Per-case flag overrides; missing keys take the file's / launch defaults. */
  flags: PermissionFlagsSchema.partial().optional(),
  /** `canViewObject` result (RLS select / `*_get` RPC succeeds). */
  expect: z.boolean(),
  join: FixtureJoinProbeSchema.optional(),
  send: FixtureSendProbeSchema.optional(),
})
export type FixtureCase = z.infer<typeof FixtureCaseSchema>

export const FixtureFileSchema = z.object({
  object: ViewableObjectTypeSchema,
  description: z.string().optional(),
  /** File-level flag defaults. */
  flags: PermissionFlagsSchema.partial().optional(),
  cases: z.array(FixtureCaseSchema).min(1),
})
export type FixtureFile = z.infer<typeof FixtureFileSchema>

/** A case with its object and flags resolved, ready for `canViewObject`. */
export interface ResolvedFixtureCase {
  readonly name: string
  readonly viewer: Viewer
  readonly object: ViewableObject
  readonly flags: PermissionFlags
  readonly expect: boolean
  readonly join: FixtureJoinProbe | undefined
  readonly send: FixtureSendProbe | undefined
}

export function fixturePath(objectType: ViewableObjectType): string {
  return `${FIXTURES_DIR}${objectType}.json`
}

/** Parses fixture JSON text; throws a `ZodError` when it does not match the format. */
export function parseFixtureFile(json: string): FixtureFile {
  return FixtureFileSchema.parse(JSON.parse(json))
}

export function loadFixtureFile(objectType: ViewableObjectType): FixtureFile {
  return parseFixtureFile(readFileSync(fixturePath(objectType), 'utf8'))
}

/** Flag overrides as a fixture file or case carries them (absent or `undefined` = keep). */
export type PermissionFlagOverrides = {
  readonly [K in keyof PermissionFlags]?: PermissionFlags[K] | undefined
}

/** Launch defaults, then the file's overrides, then the case's (absent keys leave the value). */
export function mergeFixtureFlags(
  ...overrides: ReadonlyArray<PermissionFlagOverrides | undefined>
): PermissionFlags {
  const flags: PermissionFlags = { ...DEFAULT_PERMISSION_FLAGS }
  for (const override of overrides) {
    if (override === undefined) continue
    if (override.publicWorldEnabled !== undefined)
      flags.publicWorldEnabled = override.publicWorldEnabled
    if (override.publicLiveEnabled !== undefined)
      flags.publicLiveEnabled = override.publicLiveEnabled
    if (override.guestRoomsEnabled !== undefined)
      flags.guestRoomsEnabled = override.guestRoomsEnabled
  }
  return flags
}

export function resolveFixtureCase(
  file: FixtureFile,
  fixtureCase: FixtureCase,
): ResolvedFixtureCase {
  const object = ViewableObjectSchema.parse({ ...fixtureCase.object, type: file.object })
  return {
    name: fixtureCase.name,
    viewer: fixtureCase.viewer,
    object,
    flags: mergeFixtureFlags(file.flags, fixtureCase.flags),
    expect: fixtureCase.expect,
    join: fixtureCase.join,
    send: fixtureCase.send,
  }
}

/** Every fixture file, resolved. */
export function loadAllFixtures(): ReadonlyArray<{
  readonly object: ViewableObjectType
  readonly file: FixtureFile
  readonly cases: readonly ResolvedFixtureCase[]
}> {
  return VIEWABLE_OBJECT_TYPES.map((object) => {
    const file = loadFixtureFile(object)
    return { object, file, cases: file.cases.map((c) => resolveFixtureCase(file, c)) }
  })
}
