/**
 * "Join them" on a group invite (spec §46–§47): Visitors continue into the join-group claim flow
 * with the token; Humans join (`group_invite_join`) and open the conversation; members just
 * open it.
 */
import { copy, space } from '@earth/ui'
import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { StatusLine } from '@/components/ui/StatusLine'
import { markClaimTracked } from '@/lib/claim/tracking'
import { shellCopy } from '@/lib/copy'
import { errorCode } from '@/lib/errors'
import { lightTap } from '@/lib/haptics'
import { useAnalytics, useEarth, useSession } from '@/lib/providers'
import { claimJoinHref, conversationRoute } from '@/lib/routes'

export interface JoinInviteProps {
  readonly token: string
  readonly alreadyMember: boolean
  readonly expired: boolean
}

export function JoinInvite({ token, alreadyMember, expired }: JoinInviteProps) {
  const earth = useEarth()
  const session = useSession()
  const analytics = useAnalytics()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (expired && !alreadyMember) {
    return <StatusLine message={shellCopy.inviteExpired} />
  }

  const join = async () => {
    lightTap()
    setError(null)
    if (session.roleKind !== 'human') {
      analytics.track('claim_started', { entry: 'group_invite', hasGroupInvite: true })
      markClaimTracked()
      router.push(claimJoinHref(token))
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
      router.replace(conversationRoute(joined.conversationId))
    } catch (cause) {
      const code = errorCode(cause)
      setError(
        code === 'invite_expired'
          ? shellCopy.inviteExpired
          : code === 'invite_invalid' || code === 'invite_exhausted'
            ? shellCopy.inviteInvalid
            : shellCopy.somethingWrong,
      )
      setBusy(false)
    }
  }

  return (
    <View style={styles.actions}>
      {alreadyMember ? <StatusLine message={shellCopy.alreadyMember} /> : null}
      <Button
        variant="primary"
        fullWidth
        loading={busy || session.status === 'loading'}
        label={alreadyMember ? shellCopy.openConversation : copy.joinThem}
        onPress={() => void join()}
      />
      {error !== null ? <StatusLine message={error} danger /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  actions: { gap: space[3] },
})
