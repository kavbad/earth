'use client'

import { copy } from '@earth/ui'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '../../../components/ui/Button'
import { markClaimTracked } from '../../../lib/claim/tracking'
import { webCopy } from '../../../lib/copy'
import { errorCode } from '../../../lib/errors'
import { useAnalytics } from '../../../lib/providers/AnalyticsProvider'
import { useEarth } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'
import { claimJoinRoute, conversationRoute } from '../../../lib/routes'

export interface JoinInviteProps {
  readonly token: string
  readonly alreadyMember: boolean
  readonly expired: boolean
}

/** "Join them": Visitors → claim flow with the token; Humans → `group_invite_join` → the conversation. */
export function JoinInvite({ token, alreadyMember, expired }: JoinInviteProps) {
  const earth = useEarth()
  const session = useSession()
  const analytics = useAnalytics()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (expired && !alreadyMember) {
    return <p className="text-body text-text-secondary">{webCopy.inviteExpired}</p>
  }

  const join = async () => {
    setError(null)
    if (session.roleKind !== 'human') {
      analytics.track('claim_started', { entry: 'group_invite', hasGroupInvite: true })
      markClaimTracked()
      router.push(claimJoinRoute(token))
      return
    }
    setBusy(true)
    try {
      const joined = await earth.groups.invites.join(token)
      analytics.track('group_invite_opened', { groupId: joined.groupId, viewerState: 'human' })
      if (!joined.alreadyMember) {
        analytics.track('group_joined', {
          groupId: joined.groupId,
          viaInvite: true,
          duringClaim: false,
          memberGroupCount: joined.isSecondGroup ? 2 : 1,
        })
      }
      router.push(conversationRoute(joined.conversationId))
    } catch (cause) {
      const code = errorCode(cause)
      setError(
        code === 'invite_expired'
          ? webCopy.inviteExpired
          : code === 'invite_invalid' || code === 'invite_exhausted'
            ? webCopy.inviteInvalid
            : webCopy.somethingWrong,
      )
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {alreadyMember ? (
        <p className="text-secondary text-text-secondary">{webCopy.alreadyMember}</p>
      ) : null}
      <Button
        variant="primary"
        fullWidth
        loading={busy || session.status === 'loading'}
        onClick={() => void join()}
      >
        {alreadyMember ? webCopy.openConversation : copy.joinThem}
      </Button>
      {error !== null ? (
        <p role="alert" className="text-secondary text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}
