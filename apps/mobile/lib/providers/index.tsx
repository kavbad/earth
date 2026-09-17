/**
 * The provider stack of the app (ARCHITECTURE §7, §12; spec §14, §51, §96, §107) — mounted once
 * in `app/_layout.tsx`. Hooks: `useEarth`, `useRuntime`, `usePublicEnv`, `useSession`,
 * `useFlags`, `useScope(surface)`, `useOnline`, `useAnalytics`, `useErrorMonitor`, `useHaptics`,
 * plus `useToast` and `useClaimGate` from the shell components. Feature shells
 * (`features/<feature>/shell.ts`) import exactly these names.
 */
import type { ReactNode } from 'react'

import { ClaimSheetProvider } from '@/components/shell/ClaimSheet'
import { ToastProvider } from '@/components/ui/Toast'

import { AnalyticsProvider } from './AnalyticsProvider'
import { ErrorMonitorProvider } from './ErrorMonitorProvider'
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
          <ErrorMonitorProvider>
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
          </ErrorMonitorProvider>
        </SessionProvider>
      </QueryProvider>
    </RuntimeProvider>
  )
}

export { useEarth, usePublicEnv, useRuntime } from './RuntimeProvider'
export type { RuntimeContextValue } from './RuntimeProvider'
export { useSession } from './SessionProvider'
export type { SessionContextValue } from './SessionProvider'
export { useFlags } from './FlagsProvider'
export { useAnalytics } from './AnalyticsProvider'
export type { AnalyticsContextValue } from './AnalyticsProvider'
export { useScope } from './ScopeProvider'
export type { SurfaceScope } from './ScopeProvider'
export { useOnline } from './OfflineProvider'
export { useErrorMonitor } from './ErrorMonitorProvider'
export { useHaptics } from '../haptics'
export type { HapticsApi } from '../haptics'
export { useToast } from '@/components/ui/Toast'
export type { ToastContextValue } from '@/components/ui/Toast'
export { useClaimGate } from '@/components/shell/ClaimSheet'
export type { ClaimGate } from '@/components/shell/ClaimSheet'
