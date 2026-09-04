'use client'

import { APP_NAME } from '@earth/ui'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { OfflineBanner } from '../../../components/shell/OfflineBanner'
import { Spinner } from '../../../components/ui/Spinner'
import { ROUTES } from '../../../lib/routes'
import { useClaimFlow } from './ClaimFlowProvider'

/** The claim flow's quiet chrome: wordmark, one narrow column, nothing else (spec §88). */
export function ClaimFrame({ children }: { readonly children: ReactNode }) {
  const { ready } = useClaimFlow()
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col px-screen-margin pt-[env(safe-area-inset-top)] pb-[calc(var(--earth-space-6)+env(safe-area-inset-bottom))]">
      <div className="flex min-h-touch-target items-center py-3">
        <Link href={ROUTES.home} className="text-title">
          {APP_NAME}
        </Link>
      </div>
      <OfflineBanner />
      {ready ? (
        <div className="fade-in flex flex-1 flex-col py-6">{children}</div>
      ) : (
        <div className="flex flex-1 items-center justify-center py-12">
          <Spinner />
        </div>
      )}
    </main>
  )
}

export function ClaimTitle({ children }: { readonly children: ReactNode }) {
  return <h1 className="mb-6 text-title">{children}</h1>
}
