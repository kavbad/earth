/**
 * Analytics façade (spec §13, §96–§97): the typed `track` from `@earth/analytics` fanned out to
 * PostHog (`posthog-react-native`, only when `EXPO_PUBLIC_POSTHOG_KEY` is set) and the
 * first-party sink. Identity follows the session — Humans are identified by `humanId`, Visitors
 * ride on a device-level anonymous id that survives sign-out. Events tracked before the client
 * exists are kept (bounded) and replayed.
 */
import {
  type AnalyticsClient,
  type AnalyticsEventMap,
  type AnalyticsIdentity,
  type EventName,
  type PostHogReactNativeLike,
  resolveAnonymousVisitorId,
} from '@earth/analytics'
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Platform } from 'react-native'

import packageJson from '../../package.json'
import { analyticsPlatformFor, createMobileAnalytics } from '../analytics/setup'
import { deviceStorage } from '../deviceStorage'
import { isDevelopmentEnv } from '../env'
import { readString, writeString } from '../storage'
import { useRuntime } from './RuntimeProvider'
import { useSession } from './SessionProvider'

export interface AnalyticsContextValue {
  track<E extends EventName>(name: E, properties: AnalyticsEventMap[E]): void
}

const NOOP: AnalyticsContextValue = { track: () => undefined }
const AnalyticsContext = createContext<AnalyticsContextValue>(NOOP)

const MAX_BUFFERED_EVENTS = 50
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com'

type Buffered = { readonly name: EventName; readonly properties: Record<string, unknown> }

async function initPostHog(
  key: string,
  host: string | undefined,
): Promise<PostHogReactNativeLike | null> {
  try {
    const mod = await import('posthog-react-native')
    const client = new mod.PostHog(key, {
      host: host ?? DEFAULT_POSTHOG_HOST,
      captureAppLifecycleEvents: false,
    })
    return client
  } catch {
    return null
  }
}

export function AnalyticsProvider({ children }: { readonly children: ReactNode }) {
  const { runtime } = useRuntime()
  const session = useSession()
  const [client, setClient] = useState<AnalyticsClient | null>(null)
  const identity = useRef<AnalyticsIdentity>({})
  const buffer = useRef<Buffered[]>([])
  const identifiedHuman = useRef<string | null>(null)

  // Identity is read lazily per event so the ref always reflects the latest session. Humans are
  // identified once; a sign-out resets the vendor; Visitors keep their anonymous id untouched.
  useEffect(() => {
    const next: AnalyticsIdentity = { ...identity.current }
    if (session.humanId === null) delete next.humanId
    else next.humanId = session.humanId
    identity.current = next
    if (client === null || session.status !== 'ready') return
    if (session.humanId !== null && identifiedHuman.current !== session.humanId) {
      client.identify(next)
      identifiedHuman.current = session.humanId
    } else if (session.humanId === null && identifiedHuman.current !== null) {
      client.reset()
      identifiedHuman.current = null
    }
  }, [client, session.humanId, session.status])

  useEffect(() => {
    if (runtime === null) return
    let cancelled = false
    const build = async () => {
      const anonymousVisitorId = await resolveAnonymousVisitorId({
        storage: {
          get: (key) => readString(deviceStorage(), key),
          set: (key, value) => writeString(deviceStorage(), key, value),
        },
      })
      identity.current = { ...identity.current, anonymousVisitorId }
      const key = runtime.env.POSTHOG_KEY
      const posthog = key === undefined ? null : await initPostHog(key, runtime.env.POSTHOG_HOST)
      if (cancelled) return
      const created = createMobileAnalytics({
        appVersion: packageJson.version,
        platform: analyticsPlatformFor(Platform.OS),
        apiBaseUrl: runtime.env.API_BASE_URL,
        fetch: (input, init) => fetch(input, init),
        getAccessToken: () => runtime.session.getAccessToken(),
        posthog,
        isDevelopment: isDevelopmentEnv(runtime.env),
        identity: () => identity.current,
      })
      for (const event of buffer.current) {
        created.track(event.name, event.properties as AnalyticsEventMap[typeof event.name])
      }
      buffer.current = []
      setClient(created)
    }
    void build()
    return () => {
      cancelled = true
    }
  }, [runtime])

  const value = useMemo<AnalyticsContextValue>(
    () => ({
      track(name, properties) {
        if (client !== null) {
          client.track(name, properties)
          return
        }
        if (buffer.current.length >= MAX_BUFFERED_EVENTS) buffer.current.shift()
        buffer.current.push({ name, properties })
      },
    }),
    [client],
  )

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>
}

export function useAnalytics(): AnalyticsContextValue {
  return useContext(AnalyticsContext)
}
