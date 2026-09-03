'use client'

/**
 * Spec §49 — "You're on Earth." White, centered, the person's name and face, a very restrained
 * point of motion, and one CTA: "Enter Weekend Crew" straight into the group's conversation.
 */
import { APP_NAME } from '@earth/ui'
import { copy } from '@earth/ui'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { useEffect, useSyncExternalStore } from 'react'

import { Avatar } from '../../components/ui/Avatar'
import { Button } from '../../components/ui/Button'
import {
  consumeCompletion,
  getCompletionServerSnapshot,
  getCompletionSnapshot,
  subscribeCompletion,
} from '../../lib/claim/completionStore'
import { destinationAfterClaim, enterGroupLabel } from '../../lib/claim/flow'
import { webCopy } from '../../lib/copy'
import { useEarth } from '../../lib/providers/RuntimeProvider'
import { useSession } from '../../lib/providers/SessionProvider'
import { ROUTES } from '../../lib/routes'

export default function WelcomePage() {
  const earth = useEarth()
  const session = useSession()
  const router = useRouter()
  const completion = useSyncExternalStore(
    subscribeCompletion,
    getCompletionSnapshot,
    getCompletionServerSnapshot,
  )

  // Nobody lands here by accident: without a fresh completion, Humans go Home, others to the gate.
  useEffect(() => {
    if (completion !== null || session.status !== 'ready') return
    router.replace(session.roleKind === 'human' ? ROUTES.home : ROUTES.claim)
  }, [completion, session.status, session.roleKind, router])

  const group = useQuery({
    queryKey: ['group', completion?.groupId],
    queryFn: () => earth.groups.get(completion!.groupId),
    enabled: completion !== null && completion !== undefined && session.roleKind === 'human',
  })

  if (completion === null || completion === undefined) return null

  const identity = session.identity
  const label = enterGroupLabel(group.data?.name ?? null, webCopy.enterYourGroup)

  const enter = () => {
    consumeCompletion()
    router.replace(destinationAfterClaim(completion))
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[420px] flex-col items-center justify-center gap-8 px-screen-margin text-center">
      <span
        aria-hidden="true"
        className="fade-in size-3 rounded-avatar bg-earth-accent [animation-duration:var(--earth-duration-slow)]"
      />
      <div className="fade-in flex flex-col items-center gap-4 [animation-delay:120ms]">
        <h1 className="text-display">{copy.youreOnEarth}</h1>
        {identity !== null ? (
          <div className="flex flex-col items-center gap-3">
            <Avatar
              name={identity.displayName}
              src={identity.avatarUrl}
              size="profile"
              decorative
            />
            <p className="text-section">{identity.displayName}</p>
          </div>
        ) : null}
      </div>
      <div className="fade-in w-full [animation-delay:240ms]">
        <Button variant="primary" fullWidth onClick={enter} loading={group.isLoading}>
          {label}
        </Button>
      </div>
      <p className="sr-only">{APP_NAME}</p>
    </main>
  )
}
