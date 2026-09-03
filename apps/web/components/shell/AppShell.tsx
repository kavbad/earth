'use client'

import type { ReactNode } from 'react'

import { BottomNav, LeftRail } from './AppNav'
import { OfflineBanner } from './OfflineBanner'

/** Member shell (spec §50): bottom navigation on phones, a slim left rail from 900px up. */
export function AppShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-dvh w-full">
      <LeftRail />
      <div className="flex min-w-0 flex-1 flex-col pb-[calc(var(--earth-space-16)+env(safe-area-inset-bottom))] rail:pb-0">
        <OfflineBanner />
        <main className="flex min-w-0 flex-1 flex-col">{children}</main>
      </div>
      <BottomNav />
    </div>
  )
}
