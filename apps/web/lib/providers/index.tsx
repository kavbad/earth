'use client'

/**
 * The provider stack of the web client (ARCHITECTURE §7, §12; spec §51, §96, §107) — mounted
 * once in `app/layout.tsx`. Hooks: `useEarth`, `useSession`, `useFlags`, `useScope(surface)`,
 * `useOnline`, `useAnalytics`, plus `useToast` and `useClaimGate` from the shell components.
 */
import type { ReactNode } from 'react'

import { ClaimSheetProvider } from '../../components/shell/ClaimSheet'
import { ToastProvider } from '../../components/ui/Toast'
import { AnalyticsProvider } from './AnalyticsProvider'
import { FlagsProvider } from './FlagsProvider'
import { OfflineProvider } from './OfflineProvider'
import { QueryProvider } from './QueryProvider'
import { RuntimeProvider } from './RuntimeProvider'
import { ScopeProvider } from './ScopeProvider'
import { SessionProvider } from './SessionProvider'

export function EarthProviders({ children }: { readonly children: ReactNode }) {
  return (
    <RuntimeProvider>
      <QueryProvider>
        <SessionProvider>
          <FlagsProvider>
            <AnalyticsProvider>
              <ScopeProvider>
                <OfflineProvider>
                  <ToastProvider>
                    <ClaimSheetProvider>{children}</ClaimSheetProvider>
                  </ToastProvider>
                </OfflineProvider>
              </ScopeProvider>
            </AnalyticsProvider>
          </FlagsProvider>
        </SessionProvider>
      </QueryProvider>
    </RuntimeProvider>
  )
}

export { useEarth, usePublicEnv, useRuntime } from './RuntimeProvider'
export { useSession } from './SessionProvider'
export { useFlags } from './FlagsProvider'
export { useAnalytics } from './AnalyticsProvider'
export { useScope } from './ScopeProvider'
export { useOnline } from './OfflineProvider'
export { useToast } from '../../components/ui/Toast'
export { useClaimGate } from '../../components/shell/ClaimSheet'
