/**
 * expo-linking bound to the deep link contract (spec §112): the prefixes the app answers to
 * (`earth://`, `https://earth.social`, the configured web origin), the route a URL opens, the
 * app URL of a route (return links such as the verification round trip) and opening links
 * outside the app. expo-router matches the file routes itself (`/g/[token]`, `/live/[token]`,
 * `/p/[id]`); `app/+native-intent.tsx` rewrites `/@handle` to `/u/[handle]` first.
 */
import * as Linking from 'expo-linking'
import { useMemo } from 'react'

import {
  APP_SCHEME,
  CANONICAL_WEB_ORIGIN,
  WEB_HOST,
  linkingPrefixes,
  routeForDeepLink,
  routeForUrl,
} from './deeplinks'
import { usePublicEnv } from './providers/RuntimeProvider'

export {
  APP_SCHEME,
  CANONICAL_WEB_ORIGIN,
  WEB_HOST,
  linkingPrefixes,
  routeForDeepLink,
  routeForUrl,
}

export interface EarthLinking {
  readonly scheme: typeof APP_SCHEME
  readonly prefixes: readonly string[]
  /** The in-app route a URL opens, or `null` when it is not one of the contract's links. */
  route(url: string): string | null
  /** `earth://…` for a route — a link the OS hands back to this app. */
  appUrl(path: string): string
  /** Opens a URL outside the app; `false` when nothing could open it. */
  openExternal(url: string): Promise<boolean>
}

export function createEarthLinking(webOrigin?: string | null): EarthLinking {
  return {
    scheme: APP_SCHEME,
    prefixes: linkingPrefixes(webOrigin),
    route: routeForUrl,
    appUrl: (path) => Linking.createURL(path),
    openExternal: async (url) => {
      try {
        await Linking.openURL(url)
        return true
      } catch {
        return false
      }
    },
  }
}

/** The linking of the running app (its web origin from the public environment). */
export function useLinking(): EarthLinking {
  const env = usePublicEnv()
  const origin = env?.WEB_ORIGIN ?? null
  return useMemo(() => createEarthLinking(origin), [origin])
}
