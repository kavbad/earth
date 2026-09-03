/**
 * Mounts every server-tier route of ARCHITECTURE §6 (`/api/rooms/:id/token`,
 * `/api/livekit/webhook`, `/api/claim/verification/*`, `/api/feed`, `/api/live`,
 * `/api/internal/*`, `/api/analytics/ingest`, `/api/diagnostics/rtc`) through the `@earth/server`
 * router. `/api/health` has its own file next to this one (a static segment wins over the
 * catch-all): it reports the server tier's readiness without going through the router.
 *
 * Node runtime: the handlers use `livekit-server-sdk`, `expo-server-sdk` and the service-role
 * Supabase client. Always dynamic: every response depends on the request.
 */
import { makeRouteHandler } from '../../../lib/server/handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** Seconds; push dispatch and sweeps may take longer than the platform default. */
export const maxDuration = 60

const handlers = makeRouteHandler()

export const GET = handlers.GET
export const POST = handlers.POST
export const PUT = handlers.PUT
export const PATCH = handlers.PATCH
export const DELETE = handlers.DELETE
