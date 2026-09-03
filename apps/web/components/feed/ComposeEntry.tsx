'use client'

/**
 * SCREEN 06 entry from Home: a quiet row with the person's face and "Say something" that opens
 * the composer with the current radius as the default audience. No floating create button.
 */
import type { Scope } from '@earth/domain'
import Link from 'next/link'

import { useSession } from '../../lib/providers/SessionProvider'
import { composeRoute } from '../posts/routes'
import { Avatar } from '../ui/Avatar'
import { feedCopy } from './copy'

export function ComposeEntry({ scope }: { readonly scope: Scope }) {
  const session = useSession()
  if (session.roleKind !== 'human' || session.identity === null) return null
  return (
    <Link
      href={composeRoute({ audience: scope })}
      aria-label={feedCopy.newPost}
      className="flex min-h-touch-target items-center gap-3 px-screen-margin py-3 transition-colors duration-fast ease-standard hover:bg-subtle-fill"
    >
      <Avatar name={session.identity.displayName} src={session.identity.avatarUrl} decorative />
      <span className="flex min-h-touch-target flex-1 items-center rounded-medium bg-subtle-fill px-4 text-body text-text-secondary">
        {feedCopy.composeEntry}
      </span>
    </Link>
  )
}
