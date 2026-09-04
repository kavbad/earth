/**
 * `GET /.well-known/assetlinks.json` (spec §112): the Android App Links statement list, rendered
 * from the deploy environment (`ANDROID_PACKAGE_NAME`, `ANDROID_SHA256_CERT_FINGERPRINTS` —
 * comma-separated, so a signing-key rotation can publish both fingerprints at once).
 */
import { wellKnownResponse } from '../../../lib/deeplinks/well-known'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET(): Response {
  return wellKnownResponse('assetlinks.json', process.env)
}
