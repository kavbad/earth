/**
 * `GET /api/health`: the readiness of the mounted server tier (ARCHITECTURE §6, §14). The probe
 * builds (or reuses) the memoised context, so the first probe after a deploy is where an invalid
 * environment fails fast: the operator sees `503 { ok: false, serverTier: 'misconfigured',
 * issues: [<variable names>] }` and the full `EnvError` in the log — instead of a green health
 * check in front of routes that all answer 500. Variable names are the only detail echoed;
 * values and messages stay in the log (spec §106).
 *
 * `next build` never runs this: the handler reads the environment when called, not when imported.
 */
import { EnvError, type EnvSource } from '@earth/config'
import { type Logger, createLogger } from '@earth/observability'
import { type EarthResponse, ok, toWebResponse } from '@earth/server'

import { getServerContext } from './deps'
import { WEB_APP_NAME, releaseFor } from './env'
import { CONTEXT_FAILED_LOG_MESSAGE } from './handler'
import type { WebServerContext } from './wiring'

export const SERVICE_NAME = WEB_APP_NAME

/** Not part of `HTTP_STATUS` in `@earth/server` (handlers never answer it); only the probe does. */
export const HTTP_STATUS_SERVICE_UNAVAILABLE = 503

export const SERVER_TIER_STATES = ['ready', 'misconfigured', 'failed'] as const
export type ServerTierState = (typeof SERVER_TIER_STATES)[number]
export const ServerTierStates = {
  ready: 'ready',
  misconfigured: 'misconfigured',
  failed: 'failed',
} as const satisfies Record<ServerTierState, ServerTierState>

export interface HealthReadyBody {
  readonly ok: true
  readonly service: typeof SERVICE_NAME
  readonly release: string
  readonly serverTier: typeof ServerTierStates.ready
}

export interface HealthDegradedBody {
  readonly ok: false
  readonly service: typeof SERVICE_NAME
  readonly release: string
  readonly serverTier: typeof ServerTierStates.misconfigured | typeof ServerTierStates.failed
  /** Offending variable names for `misconfigured`; empty for `failed`. Never values. */
  readonly issues: readonly string[]
}

export type HealthBody = HealthReadyBody | HealthDegradedBody

export interface HealthOptions {
  /** Defaults to the memoised production context. */
  readonly context?: (() => WebServerContext) | undefined
  /** Where the release name is read from when the context cannot be built. */
  readonly source?: EnvSource | undefined
  readonly logger?: Logger | undefined
}

function uniqueVariables(error: EnvError): string[] {
  return [...new Set(error.issues.map((issue) => issue.variable))]
}

/** The probe outcome for whatever `getContext` does: ready (200) or degraded (503, logged). */
export function healthResponse(
  getContext: () => WebServerContext,
  source: EnvSource,
  logger: Logger,
): EarthResponse {
  let context: WebServerContext
  try {
    context = getContext()
  } catch (cause) {
    logger.error(CONTEXT_FAILED_LOG_MESSAGE, { error: cause })
    const body: HealthDegradedBody =
      cause instanceof EnvError
        ? {
            ok: false,
            service: SERVICE_NAME,
            release: releaseFor(source),
            serverTier: ServerTierStates.misconfigured,
            issues: uniqueVariables(cause),
          }
        : {
            ok: false,
            service: SERVICE_NAME,
            release: releaseFor(source),
            serverTier: ServerTierStates.failed,
            issues: [],
          }
    return ok(body, HTTP_STATUS_SERVICE_UNAVAILABLE)
  }
  const body: HealthReadyBody = {
    ok: true,
    service: SERVICE_NAME,
    release: context.env.release,
    serverTier: ServerTierStates.ready,
  }
  return ok(body)
}

/** `GET` of the health route. */
export function makeHealthHandler(options: HealthOptions = {}): () => Response {
  const getContext = options.context ?? getServerContext
  const source = options.source ?? process.env
  const logger = options.logger ?? createLogger({ base: { service: WEB_APP_NAME } })
  return () => toWebResponse(healthResponse(getContext, source, logger))
}
