/**
 * `GET /.well-known/apple-app-site-association` (spec §112): the Universal Links association
 * document, rendered from the deploy environment (`APPLE_TEAM_ID`, `IOS_BUNDLE_ID`) so the ids
 * are configuration, not a committed file. Apple fetches it as JSON with no extension.
 *
 * Dynamic: the values are read per request, so rotating a team id is an environment change and a
 * redeploy — never a rebuild of the route's static output.
 */
import { wellKnownResponse } from '../../../lib/deeplinks/well-known'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(): Response {
  return wellKnownResponse('apple-app-site-association', process.env)
}
