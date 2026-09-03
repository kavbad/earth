/**
 * `POST /api/internal/metrics/daily` (ARCHITECTURE §6; spec PART XVII; DB_API §8): cron-protected
 * `metrics_compute_daily(day)`. `day` (`YYYY-MM-DD`) comes from the query or body and defaults to
 * the previous UTC day — the day a daily job has just finished observing.
 */
import { z } from 'zod'

import { requireCronSecret } from '../cron'
import type { ServerDeps } from '../deps'
import {
  AnyRpcResultSchema,
  type EarthRequest,
  type EarthResponse,
  ok,
  parseInput,
  readJson,
  requestQuery,
  rpcAdmin,
} from '../http'

export const METRICS_COMPUTE_DAILY_RPC = 'metrics_compute_daily' as const

export const DaySchema = z.iso.date()

export const MetricsDailyInputSchema = z.object({ day: DaySchema.optional() })

/** The UTC calendar day before `now`, as `YYYY-MM-DD`. */
export function previousUtcDay(now: Date): string {
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1))
  return previous.toISOString().slice(0, 10)
}

export interface MetricsDailyOutcome {
  readonly ok: true
  readonly day: string
  readonly result: unknown
}

export async function handleMetricsDaily(
  deps: ServerDeps,
  req: EarthRequest,
): Promise<EarthResponse> {
  requireCronSecret(deps, req)
  const body = await readJson(req).catch(() => undefined)
  const bodyDay =
    typeof body === 'object' && body !== null ? (body as { day?: unknown }).day : undefined
  const queryDay = requestQuery(req).get('day')
  const raw: Record<string, unknown> = {}
  if (bodyDay !== undefined) raw['day'] = bodyDay
  else if (queryDay !== null && queryDay !== '') raw['day'] = queryDay
  const input = parseInput(MetricsDailyInputSchema, raw, 'day')
  const day = input.day ?? previousUtcDay(deps.now())
  const result = await rpcAdmin(deps, METRICS_COMPUTE_DAILY_RPC, { day }, AnyRpcResultSchema)
  const outcome: MetricsDailyOutcome = { ok: true, day, result: result ?? null }
  return ok(outcome)
}
