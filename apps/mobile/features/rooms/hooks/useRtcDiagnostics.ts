import type { RealtimeDiagnostics } from '@earth/realtime'
import { useMemo } from 'react'

import { isDevelopmentEnv } from '@/lib/env'
import { useRuntime } from '@/lib/providers'

import { createRtcDiagnostics } from '../diagnostics'

/** One diagnostics emitter per runtime, bound to the typed client. */
export function useRtcDiagnostics(): RealtimeDiagnostics {
  const { earth, env } = useRuntime()
  return useMemo(
    () => createRtcDiagnostics({ earth, isDevelopment: env !== null && isDevelopmentEnv(env) }),
    [earth, env],
  )
}
