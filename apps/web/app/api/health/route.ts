/**
 * `GET /api/health` — readiness of the web app and its server tier (`lib/server/health.ts`):
 * 200 when the environment validates and the server context is built, 503 (still JSON) when it
 * cannot be, naming the offending variables. Its own file so the static segment wins over
 * `/api/[...earth]` and the probe never depends on the router.
 */
import { SERVICE_NAME, makeHealthHandler } from '../../../lib/server/health'

export { SERVICE_NAME }
export type { HealthBody as HealthResponse } from '../../../lib/server/health'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = makeHealthHandler()
