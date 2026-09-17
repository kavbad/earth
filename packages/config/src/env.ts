/**
 * zod-validated environment for Earth (ARCHITECTURE §14, spec §106).
 *
 * Two schemas, two consumers:
 *
 * - {@link PublicEnvSchema}: client-safe values. Bundlers only inline `process.env.NEXT_PUBLIC_*`
 *   (Next.js) / `process.env.EXPO_PUBLIC_*` (Expo) when each variable is referenced statically,
 *   so clients pass an explicit object to {@link loadPublicEnv} — never iterate `process.env`
 *   in client code. {@link PUBLIC_ENV_KEYS} lists what to reference.
 * - {@link ServerEnvSchema}: secrets and provider settings for the Node server tier. Never
 *   shipped to clients.
 *
 * Cross-variable rules (enforced by the schemas and re-checked by the loaders):
 *
 * - `HUMAN_VERIFICATION_PROVIDER=mock` is refused when `APP_ENV=production` (ARCHITECTURE §14,
 *   spec §16: production must never fall back to a fake verification state).
 * - `HUMAN_VERIFICATION_PROVIDER=vendor` requires the three vendor settings.
 * - The `localhost` development defaults of `API_BASE_URL`, `LIVEKIT_URL` and `WEB_ORIGIN` are
 *   refused unless `APP_ENV=development`: a preview or production build must say where it lives.
 * - The server resolves `APP_ENV` from `NEXT_PUBLIC_APP_ENV` / `EXPO_PUBLIC_APP_ENV` when the
 *   unprefixed variable is unset and refuses a disagreement, so a deployment cannot be
 *   "production" for its clients and "development" for its verification rules.
 *
 * Loading fails loudly with an {@link EnvError} that lists every problem at once.
 */
import { z } from 'zod'

import { LOCAL_URLS } from './constants'

// ---------------------------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------------------------

export const APP_ENVS = ['development', 'preview', 'production'] as const
export const AppEnvSchema = z.enum(APP_ENVS)
export type AppEnv = z.infer<typeof AppEnvSchema>
/** Object form of {@link APP_ENVS} so comparisons never use string literals. */
export const AppEnvs = AppEnvSchema.enum

export const HUMAN_VERIFICATION_PROVIDERS = ['mock', 'manual_review', 'vendor'] as const
export const HumanVerificationProviderSchema = z.enum(HUMAN_VERIFICATION_PROVIDERS)
/** Which `HumanVerificationProvider` implementation (`@earth/auth`) the server tier instantiates. */
export type HumanVerificationProviderKind = z.infer<typeof HumanVerificationProviderSchema>
export const HumanVerificationProviders = HumanVerificationProviderSchema.enum

export const PUBLIC_ENV_PREFIXES = ['NEXT_PUBLIC_', 'EXPO_PUBLIC_'] as const
export type PublicEnvPrefix = (typeof PUBLIC_ENV_PREFIXES)[number]
/** Prefix per client bundler. */
export const PublicEnvPrefixes = {
  web: 'NEXT_PUBLIC_',
  mobile: 'EXPO_PUBLIC_',
} as const satisfies Record<string, PublicEnvPrefix>

export const ENV_SCOPES = ['public', 'server'] as const
export type EnvScope = (typeof ENV_SCOPES)[number]

// ---------------------------------------------------------------------------------------------
// Defaults (development only where safe; preview and production must set the rest explicitly)
// ---------------------------------------------------------------------------------------------

export const DEFAULT_APP_ENV: AppEnv = AppEnvs.development
export const DEFAULT_API_BASE_URL: string = LOCAL_URLS.web
export const DEFAULT_WEB_ORIGIN: string = LOCAL_URLS.web
export const DEFAULT_LIVEKIT_URL: string = LOCAL_URLS.livekit
/** Matches `ROOM_GRACE_SECONDS_DEFAULT` in `@earth/domain` and `rooms_sweep()` (ARCHITECTURE §10). */
export const DEFAULT_ROOM_GRACE_SECONDS = 120
/** HS256 needs a 256-bit key; GoTrue and PostgREST refuse shorter secrets. */
export const SUPABASE_JWT_SECRET_MIN_LENGTH = 32
export const INTERNAL_CRON_SECRET_MIN_LENGTH = 16

// ---------------------------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------------------------

const NonEmptyString = z.string().min(1)

const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '')

/** `http(s)://…` — used verbatim (Sentry DSNs carry credentials and a path). */
const HttpUrlSchema = z.url({ protocol: /^https?$/ })

/** `http(s)://…` with trailing slashes removed so callers can append paths safely. */
const HttpBaseUrlSchema = HttpUrlSchema.transform(stripTrailingSlashes)

const ORIGIN_MESSAGE =
  'must be an origin (scheme://host[:port]) with no path, query, fragment or credentials'

/**
 * `scheme://host[:port]` only, canonicalised the way browsers report `location.origin`
 * (lower-case host, default port dropped) so deep links and share links compare exactly.
 */
const OriginSchema = HttpUrlSchema.transform((value, ctx) => {
  const url = new URL(value)
  const isOrigin =
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    new URL(stripTrailingSlashes(value)).pathname === '/'
  if (!isOrigin) {
    ctx.addIssue({ code: 'custom', message: ORIGIN_MESSAGE })
    return z.NEVER
  }
  return url.origin
})

/** LiveKit accepts `ws(s)://` and `http(s)://` forms of the same endpoint. */
const RtcUrlSchema = z.url({ protocol: /^(wss?|https?)$/ })

/**
 * Whole seconds as an environment string. Deliberately not `z.coerce.number()`, which turns
 * `""` into `0` (a `ROOM_GRACE_SECONDS=` line would end rooms instantly) and accepts hex and
 * exponent notation.
 */
const RoomGraceSecondsSchema = z
  .string()
  .trim()
  .regex(/^\d+$/, 'must be a non-negative whole number of seconds')
  .transform(Number)
  .refine(Number.isSafeInteger, { message: 'is too large' })

// ---------------------------------------------------------------------------------------------
// Shared error shape
// ---------------------------------------------------------------------------------------------

export interface EnvIssue {
  /** Fully prefixed variable name as the operator must set it (for example `NEXT_PUBLIC_SUPABASE_URL`). */
  readonly variable: string
  readonly message: string
}

/** Appends `extras` that are not already present (same variable and message). */
function mergeIssues(issues: EnvIssue[], extras: readonly EnvIssue[]): void {
  for (const extra of extras) {
    const seen = issues.some(
      (issue) => issue.variable === extra.variable && issue.message === extra.message,
    )
    if (!seen) issues.push(extra)
  }
}

// ---------------------------------------------------------------------------------------------
// Public (client-safe) environment — ARCHITECTURE §14
// ---------------------------------------------------------------------------------------------

const PublicEnvShape = {
  SUPABASE_URL: HttpBaseUrlSchema,
  SUPABASE_ANON_KEY: NonEmptyString,
  API_BASE_URL: HttpBaseUrlSchema.default(DEFAULT_API_BASE_URL),
  LIVEKIT_URL: RtcUrlSchema.default(DEFAULT_LIVEKIT_URL),
  POSTHOG_KEY: NonEmptyString.optional(),
  POSTHOG_HOST: HttpBaseUrlSchema.optional(),
  SENTRY_DSN: HttpUrlSchema.optional(),
  MAP_STYLE_URL: HttpUrlSchema,
  APP_ENV: AppEnvSchema.default(DEFAULT_APP_ENV),
  WEB_ORIGIN: OriginSchema.default(DEFAULT_WEB_ORIGIN),
} as const

export type PublicEnvKey = keyof typeof PublicEnvShape

/**
 * Public variables whose default points at the local stack. Outside `APP_ENV=development` the
 * default (or an explicit `localhost` copy of it) is refused: clients of a preview or production
 * build are remote, and `WEB_ORIGIN` would otherwise silently mint `http://localhost` share links.
 */
export const PUBLIC_DEVELOPMENT_DEFAULT_KEYS = [
  'API_BASE_URL',
  'LIVEKIT_URL',
  'WEB_ORIGIN',
] as const satisfies readonly PublicEnvKey[]
export type PublicDevelopmentDefaultKey = (typeof PUBLIC_DEVELOPMENT_DEFAULT_KEYS)[number]

const PUBLIC_DEVELOPMENT_DEFAULTS: Readonly<Record<PublicDevelopmentDefaultKey, string>> = {
  API_BASE_URL: DEFAULT_API_BASE_URL,
  LIVEKIT_URL: DEFAULT_LIVEKIT_URL,
  WEB_ORIGIN: DEFAULT_WEB_ORIGIN,
}

/** Raw or parsed public values the cross-field rules look at. */
type PublicCrossFieldInput = Partial<Record<PublicDevelopmentDefaultKey | 'APP_ENV', string>>

/**
 * Rules that span several public variables. Pure so that the schema's refinement and
 * {@link loadPublicEnv} share it; variables are reported unprefixed and prefixed by the caller.
 */
function publicCrossFieldIssues(env: PublicCrossFieldInput): EnvIssue[] {
  const issues: EnvIssue[] = []
  const appEnv = AppEnvSchema.safeParse(env.APP_ENV ?? DEFAULT_APP_ENV)
  // An invalid APP_ENV is reported on its own; only a real preview/production value triggers this.
  if (!appEnv.success || appEnv.data === AppEnvs.development) return issues
  for (const key of PUBLIC_DEVELOPMENT_DEFAULT_KEYS) {
    const fallback = PUBLIC_DEVELOPMENT_DEFAULTS[key]
    const value = env[key] === undefined ? fallback : stripTrailingSlashes(env[key])
    if (value === fallback) {
      issues.push({
        variable: key,
        message: `development default "${fallback}" is refused when APP_ENV=${appEnv.data}; set it explicitly`,
      })
    }
  }
  return issues
}

export const PublicEnvSchema = z.object(PublicEnvShape).superRefine((env, ctx) => {
  for (const issue of publicCrossFieldIssues(env)) {
    ctx.addIssue({ code: 'custom', path: [issue.variable], message: issue.message })
  }
})

export type PublicEnv = z.infer<typeof PublicEnvSchema>

/** Unprefixed public variable names, in schema order. Reference each one statically in client code. */
export const PUBLIC_ENV_KEYS = Object.keys(PublicEnvShape) as readonly PublicEnvKey[]

// ---------------------------------------------------------------------------------------------
// Server environment — ARCHITECTURE §14
// ---------------------------------------------------------------------------------------------

/** Vendor settings that must be present when `HUMAN_VERIFICATION_PROVIDER=vendor`. */
export const HUMAN_VERIFICATION_VENDOR_KEYS = [
  'HUMAN_VERIFICATION_VENDOR_URL',
  'HUMAN_VERIFICATION_VENDOR_KEY',
  'HUMAN_VERIFICATION_WEBHOOK_SECRET',
] as const

/** Raw or parsed server values the cross-field rules look at. */
interface ServerCrossFieldInput {
  readonly APP_ENV?: string | undefined
  readonly HUMAN_VERIFICATION_PROVIDER?: string | undefined
  readonly HUMAN_VERIFICATION_VENDOR_URL?: string | undefined
  readonly HUMAN_VERIFICATION_VENDOR_KEY?: string | undefined
  readonly HUMAN_VERIFICATION_WEBHOOK_SECRET?: string | undefined
}

/**
 * Rules that span several server variables (ARCHITECTURE §14). Pure so that the schema's
 * refinement and {@link loadServerEnv} share it: whether zod runs an object refinement once a
 * field has already failed differs between versions, so the loader re-derives these from the
 * raw values and dedupes, and every problem is reported once either way.
 */
function serverCrossFieldIssues(env: ServerCrossFieldInput): EnvIssue[] {
  const issues: EnvIssue[] = []
  const appEnv = env.APP_ENV ?? DEFAULT_APP_ENV
  // The mock provider verifies nobody; it must never reach production.
  if (
    appEnv === AppEnvs.production &&
    env.HUMAN_VERIFICATION_PROVIDER === HumanVerificationProviders.mock
  ) {
    issues.push({
      variable: 'HUMAN_VERIFICATION_PROVIDER',
      message: `"${HumanVerificationProviders.mock}" is refused when APP_ENV=${AppEnvs.production}; use "${HumanVerificationProviders.manual_review}" or "${HumanVerificationProviders.vendor}"`,
    })
  }
  if (env.HUMAN_VERIFICATION_PROVIDER === HumanVerificationProviders.vendor) {
    for (const key of HUMAN_VERIFICATION_VENDOR_KEYS) {
      if (env[key] === undefined) {
        issues.push({
          variable: key,
          message: `required when HUMAN_VERIFICATION_PROVIDER=${HumanVerificationProviders.vendor}`,
        })
      }
    }
  }
  return issues
}

export const ServerEnvSchema = z
  .object({
    APP_ENV: AppEnvSchema.default(DEFAULT_APP_ENV),
    SUPABASE_SERVICE_ROLE_KEY: NonEmptyString,
    SUPABASE_JWT_SECRET: z.string().min(SUPABASE_JWT_SECRET_MIN_LENGTH),
    LIVEKIT_API_KEY: NonEmptyString,
    LIVEKIT_API_SECRET: NonEmptyString,
    LIVEKIT_URL: RtcUrlSchema.default(DEFAULT_LIVEKIT_URL),
    HUMAN_VERIFICATION_PROVIDER: HumanVerificationProviderSchema,
    HUMAN_VERIFICATION_VENDOR_URL: HttpBaseUrlSchema.optional(),
    HUMAN_VERIFICATION_VENDOR_KEY: NonEmptyString.optional(),
    HUMAN_VERIFICATION_WEBHOOK_SECRET: NonEmptyString.optional(),
    EXPO_ACCESS_TOKEN: NonEmptyString.optional(),
    INTERNAL_CRON_SECRET: z.string().min(INTERNAL_CRON_SECRET_MIN_LENGTH),
    POSTHOG_SERVER_KEY: NonEmptyString.optional(),
    SENTRY_DSN: HttpUrlSchema.optional(),
    ROOM_GRACE_SECONDS: RoomGraceSecondsSchema.default(DEFAULT_ROOM_GRACE_SECONDS),
  })
  .superRefine((env, ctx) => {
    for (const issue of serverCrossFieldIssues(env)) {
      ctx.addIssue({ code: 'custom', path: [issue.variable], message: issue.message })
    }
  })

export type ServerEnv = z.infer<typeof ServerEnvSchema>
export type ServerEnvKey = keyof ServerEnv

/** Server variable names, in schema order. */
export const SERVER_ENV_KEYS = Object.keys(ServerEnvSchema.shape) as readonly ServerEnvKey[]

/** Server variables that are secrets (spec §106): never logged, never committed, never shipped. */
export const SERVER_SECRET_KEYS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
  'LIVEKIT_API_SECRET',
  'HUMAN_VERIFICATION_VENDOR_KEY',
  'HUMAN_VERIFICATION_WEBHOOK_SECRET',
  'EXPO_ACCESS_TOKEN',
  'INTERNAL_CRON_SECRET',
  'POSTHOG_SERVER_KEY',
] as const satisfies readonly ServerEnvKey[]

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Thrown by {@link loadPublicEnv} / {@link loadServerEnv}; `issues` lists every problem found. */
export class EnvError extends Error {
  override readonly name = 'EnvError'

  constructor(
    readonly scope: EnvScope,
    readonly issues: readonly EnvIssue[],
  ) {
    super(formatEnvErrorMessage(scope, issues))
  }
}

export function formatEnvErrorMessage(scope: EnvScope, issues: readonly EnvIssue[]): string {
  const lines = issues.map((issue) => `  - ${issue.variable}: ${issue.message}`)
  return [
    `Invalid ${scope} environment (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
    ...lines,
  ].join('\n')
}

function toEnvIssues(error: z.ZodError, prefix: string): EnvIssue[] {
  return error.issues.map((issue) => {
    const first = issue.path[0]
    const variable = first === undefined ? '(environment)' : `${prefix}${String(first)}`
    return { variable, message: issue.message }
  })
}

// ---------------------------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------------------------

/** Anything shaped like `process.env`. */
export type EnvSource = Readonly<Record<string, string | undefined>>

/** `.env` files commonly leave optional values empty (`KEY=`); treat those as unset. */
function normalizeValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** `NEXT_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_URL`, ... */
export function publicEnvVariableName<K extends PublicEnvKey, P extends PublicEnvPrefix>(
  key: K,
  prefix: P,
): `${P}${K}` {
  return `${prefix}${key}`
}

/**
 * Reads `${prefix}${KEY}` for every public key, strips the prefix and validates.
 *
 * @throws {EnvError} listing every invalid or missing variable (with its prefixed name).
 */
export function loadPublicEnv(source: EnvSource, prefix: PublicEnvPrefix): PublicEnv {
  const stripped: Partial<Record<PublicEnvKey, string>> = {}
  for (const key of PUBLIC_ENV_KEYS) {
    const value = normalizeValue(source[publicEnvVariableName(key, prefix)])
    if (value !== undefined) stripped[key] = value
  }
  const result = PublicEnvSchema.safeParse(stripped)
  if (!result.success) {
    const issues = toEnvIssues(result.error, prefix)
    mergeIssues(
      issues,
      publicCrossFieldIssues(stripped).map((issue) => ({
        variable: `${prefix}${issue.variable}`,
        message: issue.message,
      })),
    )
    throw new EnvError('public', issues)
  }
  return result.data
}

/** Public copies of `APP_ENV`; {@link loadServerEnv} falls back to them and refuses a disagreement. */
export const PUBLIC_APP_ENV_VARIABLES = PUBLIC_ENV_PREFIXES.map((prefix) =>
  publicEnvVariableName('APP_ENV', prefix),
) as readonly `${PublicEnvPrefix}APP_ENV`[]

interface ResolvedServerAppEnv {
  readonly value: string | undefined
  /** Variable the value came from, for error messages. */
  readonly variable: string
  readonly issues: readonly EnvIssue[]
}

/**
 * `APP_ENV`, or whichever public copy is set when it is not. In one deployment the server and
 * the client it serves are the same environment, so a disagreement is a misconfiguration —
 * and a server that thought it was in development would accept the mock verifier.
 */
function resolveServerAppEnv(source: EnvSource): ResolvedServerAppEnv {
  const issues: EnvIssue[] = []
  let value = normalizeValue(source['APP_ENV'])
  let variable = 'APP_ENV'
  for (const publicVariable of PUBLIC_APP_ENV_VARIABLES) {
    const publicValue = normalizeValue(source[publicVariable])
    if (publicValue === undefined) continue
    if (value === undefined) {
      value = publicValue
      variable = publicVariable
    } else if (publicValue !== value) {
      issues.push({
        variable: 'APP_ENV',
        message: `"${value}" (from ${variable}) disagrees with ${publicVariable}="${publicValue}"`,
      })
    }
  }
  return { value, variable, issues }
}

/**
 * Validates the server tier's environment.
 *
 * Refuses `HUMAN_VERIFICATION_PROVIDER=mock` when `APP_ENV=production`, requires the vendor
 * settings when the provider is `vendor`, and resolves `APP_ENV` from its public copies when
 * the unprefixed variable is unset (refusing a disagreement).
 *
 * @throws {EnvError} listing every issue at once.
 */
export function loadServerEnv(source: EnvSource): ServerEnv {
  const picked: Partial<Record<ServerEnvKey, string>> = {}
  for (const key of SERVER_ENV_KEYS) {
    const value = normalizeValue(source[key])
    if (value !== undefined) picked[key] = value
  }
  const appEnv = resolveServerAppEnv(source)
  if (appEnv.value !== undefined) picked.APP_ENV = appEnv.value

  const result = ServerEnvSchema.safeParse(picked)
  const issues: EnvIssue[] = result.success
    ? []
    : toEnvIssues(result.error, '').map((issue) =>
        issue.variable === 'APP_ENV' ? { ...issue, variable: appEnv.variable } : issue,
      )
  mergeIssues(issues, appEnv.issues)
  if (!result.success) mergeIssues(issues, serverCrossFieldIssues(picked))
  if (!result.success || issues.length > 0) throw new EnvError('server', issues)
  return result.data
}

// ---------------------------------------------------------------------------------------------
// Documentation
// ---------------------------------------------------------------------------------------------

export interface EnvVariableDoc {
  /** Unprefixed name (public) or the exact name (server). */
  readonly name: string
  /** `true` when the loader fails without it (no default, not optional). */
  readonly required: boolean
  /** Development default applied when unset, rendered as the string an operator would write. */
  readonly defaultValue: string | undefined
  /** Secret per spec §106 — must never be committed or shipped to clients. */
  readonly secret: boolean
  readonly description: string
}

export interface EnvDescription {
  /** Prefixes under which every `public` variable is read (`NEXT_PUBLIC_` for web, `EXPO_PUBLIC_` for mobile). */
  readonly publicPrefixes: readonly PublicEnvPrefix[]
  readonly public: readonly EnvVariableDoc[]
  readonly server: readonly EnvVariableDoc[]
}

const DEVELOPMENT_ONLY_DEFAULT_NOTE = `Default applies only when APP_ENV=${AppEnvs.development}; ${AppEnvs.preview} and ${AppEnvs.production} must set it.`

const PUBLIC_ENV_DESCRIPTIONS: Readonly<Record<PublicEnvKey, string>> = {
  SUPABASE_URL: `Supabase project URL. Locally the stack gateway (${LOCAL_URLS.supabase}) routes /rest/v1 to PostgREST and /auth/v1 to GoTrue.`,
  SUPABASE_ANON_KEY:
    'Supabase anon key: a JWT for role "anon" signed with SUPABASE_JWT_SECRET. Safe to ship; RLS governs access.',
  API_BASE_URL: `Origin of the Node server tier (apps/web /api routes). ${DEVELOPMENT_ONLY_DEFAULT_NOTE}`,
  LIVEKIT_URL: `LiveKit websocket URL clients connect to with a server-minted token. ${DEVELOPMENT_ONLY_DEFAULT_NOTE}`,
  POSTHOG_KEY: 'PostHog project key. Empty selects the noop analytics adapter.',
  POSTHOG_HOST: 'PostHog ingestion host.',
  SENTRY_DSN: 'Sentry DSN for the client. Empty disables error monitoring.',
  MAP_STYLE_URL: 'MapLibre style JSON URL rendered by the Earth map.',
  APP_ENV: 'Deployment environment: development | preview | production.',
  WEB_ORIGIN: `Canonical web origin used for share links and deep links (https://earth.social in production). ${DEVELOPMENT_ONLY_DEFAULT_NOTE}`,
}

const SERVER_ENV_DESCRIPTIONS: Readonly<Record<ServerEnvKey, string>> = {
  APP_ENV:
    'Deployment environment: development | preview | production. Falls back to NEXT_PUBLIC_APP_ENV / EXPO_PUBLIC_APP_ENV when unset and must agree with them. Tooling (db reset, seeds) reads it too.',
  SUPABASE_SERVICE_ROLE_KEY:
    'Supabase service-role key. Bypasses RLS; only the server tier may hold it.',
  SUPABASE_JWT_SECRET: `Secret that signs and verifies Supabase JWTs (GoTrue + PostgREST share it). At least ${SUPABASE_JWT_SECRET_MIN_LENGTH} characters.`,
  LIVEKIT_API_KEY: 'LiveKit API key used to mint room tokens and verify webhooks.',
  LIVEKIT_API_SECRET: 'LiveKit API secret paired with LIVEKIT_API_KEY.',
  LIVEKIT_URL: 'LiveKit server URL the server tier talks to.',
  HUMAN_VERIFICATION_PROVIDER:
    'Human verification provider: mock | manual_review | vendor. mock is refused when APP_ENV=production.',
  HUMAN_VERIFICATION_VENDOR_URL:
    'Vendor API base URL. Required when HUMAN_VERIFICATION_PROVIDER=vendor.',
  HUMAN_VERIFICATION_VENDOR_KEY:
    'Vendor API key. Required when HUMAN_VERIFICATION_PROVIDER=vendor.',
  HUMAN_VERIFICATION_WEBHOOK_SECRET:
    'Secret that authenticates vendor callbacks to /api/claim/verification/webhook. Required when HUMAN_VERIFICATION_PROVIDER=vendor.',
  EXPO_ACCESS_TOKEN: 'Expo push access token. Empty disables push dispatch.',
  INTERNAL_CRON_SECRET: `Shared secret required by /api/internal/* cron routes. At least ${INTERNAL_CRON_SECRET_MIN_LENGTH} characters.`,
  POSTHOG_SERVER_KEY:
    'PostHog server-side project key (posthog-node). Empty selects the noop adapter.',
  SENTRY_DSN: 'Sentry DSN for the server tier. Empty disables error monitoring.',
  ROOM_GRACE_SECONDS:
    'Seconds a room stays open with no active Humans before rooms_sweep() ends it. Whole number.',
}

function describeField(
  name: string,
  field: z.ZodType,
  description: string,
  secret: boolean,
): EnvVariableDoc {
  const unset = field.safeParse(undefined)
  const defaultValue = unset.success && unset.data !== undefined ? String(unset.data) : undefined
  return { name, required: !unset.success, defaultValue, secret, description }
}

/** Machine-readable listing of every variable, for `.env.example` and docs. */
export function describeEnv(): EnvDescription {
  const secretKeys: ReadonlySet<string> = new Set(SERVER_SECRET_KEYS)
  return {
    publicPrefixes: PUBLIC_ENV_PREFIXES,
    public: PUBLIC_ENV_KEYS.map((key) =>
      describeField(key, PublicEnvShape[key], PUBLIC_ENV_DESCRIPTIONS[key], false),
    ),
    server: SERVER_ENV_KEYS.map((key) =>
      describeField(
        key,
        ServerEnvSchema.shape[key],
        SERVER_ENV_DESCRIPTIONS[key],
        secretKeys.has(key),
      ),
    ),
  }
}
