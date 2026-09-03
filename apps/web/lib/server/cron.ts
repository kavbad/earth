/**
 * Adapts platform-scheduled requests to the cron contract of `@earth/server` (ARCHITECTURE §6):
 * `/api/internal/*` handlers require `x-earth-cron-secret: <INTERNAL_CRON_SECRET>` (compared in
 * constant time by `requireCronSecret`) on a `POST`.
 *
 * Vercel Cron (`vercel.json`) sends a `GET` with no custom headers; when the `CRON_SECRET`
 * environment variable is set it adds `Authorization: Bearer <CRON_SECRET>`. So for internal
 * routes only, this adapter:
 *
 * 1. accepts a bearer that equals `CRON_SECRET` (constant time) as the cron credential and
 *    forwards `INTERNAL_CRON_SECRET` in `x-earth-cron-secret`;
 * 2. otherwise forwards the bearer itself as `x-earth-cron-secret`, so a deployment where
 *    `CRON_SECRET` and `INTERNAL_CRON_SECRET` are the same value works too (the server still
 *    does the constant-time check; a wrong value is `forbidden`);
 * 3. treats a `GET` carrying a cron credential as the `POST` the route table defines.
 *
 * Requests without any credential are passed through untouched, so a bare `POST` stays
 * `not_authenticated` (401) and a bare `GET` stays method-not-allowed (405).
 */
import {
  AUTHORIZATION_HEADER,
  CRON_SECRET_HEADER,
  type EarthRequest,
  constantTimeEqual,
  optionalBearer,
  requestPath,
} from '@earth/server'

export const INTERNAL_ROUTE_PREFIX = '/api/internal/' as const
export const CRON_PLATFORM_METHOD = 'GET' as const
export const CRON_ROUTE_METHOD = 'POST' as const

export interface CronCredentials {
  /** `INTERNAL_CRON_SECRET` — what the server compares `x-earth-cron-secret` against. */
  readonly internalSecret: string
  /** Vercel's `CRON_SECRET`, when set. */
  readonly vercelCronSecret: string | undefined
}

export function isInternalRoute(path: string): boolean {
  return path.startsWith(INTERNAL_ROUTE_PREFIX)
}

function hasCronHeader(req: EarthRequest): boolean {
  const value = req.headers.get(CRON_SECRET_HEADER)
  return value !== null && value.trim() !== ''
}

/** The `x-earth-cron-secret` value a bearer stands for, or `null` when there is no bearer. */
export function cronSecretForBearer(
  bearer: string | null,
  credentials: CronCredentials,
): string | null {
  if (bearer === null) return null
  if (
    credentials.vercelCronSecret !== undefined &&
    constantTimeEqual(bearer, credentials.vercelCronSecret)
  ) {
    return credentials.internalSecret
  }
  return bearer
}

/** Returns `req` itself unless it is a credentialed request to an internal route. */
export function adaptCronRequest(req: EarthRequest, credentials: CronCredentials): EarthRequest {
  if (!isInternalRoute(requestPath(req))) return req
  const alreadyHasHeader = hasCronHeader(req)
  const forwarded = alreadyHasHeader ? null : cronSecretForBearer(optionalBearer(req), credentials)
  if (!alreadyHasHeader && forwarded === null) return req

  const headers = new Headers(req.headers)
  if (forwarded !== null) {
    headers.set(CRON_SECRET_HEADER, forwarded)
    // The bearer was the cron credential, not a Supabase session; do not pass it on.
    headers.delete(AUTHORIZATION_HEADER)
  }
  const method = req.method.toUpperCase() === CRON_PLATFORM_METHOD ? CRON_ROUTE_METHOD : req.method
  return { ...req, method, headers, json: () => req.json(), text: () => req.text() }
}
