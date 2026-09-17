/**
 * `POST /api/internal/rooms/sweep` (ARCHITECTURE §6): cron-protected call of `rooms_sweep()`
 * (DB_API §3 — grace-period room ends, guest expiry, location share expiry, rate-limit pruning).
 */
import { requireCronSecret } from '../cron'
import type { ServerDeps } from '../deps'
import { AnyRpcResultSchema, type EarthRequest, type EarthResponse, ok, rpcAdmin } from '../http'

export const ROOMS_SWEEP_RPC = 'rooms_sweep' as const

export interface SweepOutcome {
  readonly ok: true
  readonly ranAt: string
  /** Counts returned by `rooms_sweep()`. */
  readonly result: unknown
}

export async function handleRoomsSweep(
  deps: ServerDeps,
  req: EarthRequest,
): Promise<EarthResponse> {
  requireCronSecret(deps, req)
  const result = await rpcAdmin(deps, ROOMS_SWEEP_RPC, {}, AnyRpcResultSchema)
  const body: SweepOutcome = { ok: true, ranAt: deps.now().toISOString(), result: result ?? null }
  return ok(body)
}
