'use client'

/**
 * The frame of every Settings screen (SCREEN 25): a header with a back control and the section
 * title, then the content at reading width. Visitors and Guests never see settings (spec §43).
 */
import { copy } from '@earth/ui'
import type { Route } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { useClaimGate } from '../../../../../components/shell/ClaimSheet'
import { PageContainer } from '../../../../../components/shell/PageContainer'
import { ScreenHeader } from '../../../../../components/shell/ScreenHeader'
import { Button } from '../../../../../components/ui/Button'
import { EmptyState } from '../../../../../components/ui/EmptyState'
import { Icon } from '../../../../../components/ui/Icon'
import { Skeleton } from '../../../../../components/ui/Skeleton'
import { useSession } from '../../../../../lib/providers/SessionProvider'
import { youCopy } from '../../_lib/copy'
import { YOU_ROUTES } from '../../_lib/routes'

export interface SettingsFrameProps {
  readonly title: string
  readonly backTo?: Route
  readonly children: ReactNode
}

export function SettingsFrame({
  title,
  backTo = YOU_ROUTES.settings,
  children,
}: SettingsFrameProps) {
  const session = useSession()
  const gate = useClaimGate()
  return (
    <>
      <ScreenHeader
        title={title}
        leading={
          <Link
            href={backTo}
            aria-label={youCopy.back}
            className="flex size-touch-target items-center justify-center rounded-avatar text-text-secondary"
          >
            <Icon name="back" />
          </Link>
        }
      />
      <PageContainer className="pb-8">
        {session.status === 'loading' ? (
          <div aria-hidden="true" className="flex flex-col gap-3 px-screen-margin py-6">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        ) : session.roleKind !== 'human' ? (
          <EmptyState
            title={youCopy.notOnEarthYet}
            action={
              <Button variant="primary" onClick={() => gate.open('profile')}>
                {copy.claimYourPlace}
              </Button>
            }
          />
        ) : (
          children
        )}
      </PageContainer>
    </>
  )
}

/** A titled group of rows inside a settings screen. */
export function SettingsSection({
  title,
  hint,
  children,
}: {
  readonly title: string
  readonly hint?: string
  readonly children: ReactNode
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-2 py-4">
      <div className="flex flex-col px-screen-margin">
        <h2 className="text-section">{title}</h2>
        {hint !== undefined ? <p className="text-secondary text-text-secondary">{hint}</p> : null}
      </div>
      {children}
    </section>
  )
}
