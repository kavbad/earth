/** Spec §46: `/claim/join?token=…` hands the invite to the claim machine and continues to the credential. */
import { ClaimSteps } from '@earth/auth'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef } from 'react'

import { useClaimFlow } from '@/components/claim/ClaimFlowProvider'
import { ClaimFrame } from '@/components/claim/ClaimFrame'
import { Spinner } from '@/components/ui/Spinner'
import { stateFromPending } from '@/lib/claim/flow'
import { isClaimTracked, markClaimTracked } from '@/lib/claim/tracking'
import { shellCopy } from '@/lib/copy'
import { useAnalytics } from '@/lib/providers'
import { ROUTES, firstParam } from '@/lib/routes'

export default function ClaimJoinScreen() {
  const params = useLocalSearchParams<{ token?: string | string[] }>()
  const token = firstParam(params.token)
  const { state, ready, dispatch, flags } = useClaimFlow()
  const analytics = useAnalytics()
  const router = useRouter()
  const handled = useRef(false)

  useEffect(() => {
    if (!ready || handled.current) return
    handled.current = true
    if (token === null) {
      router.replace(ROUTES.claim)
      return
    }
    if (!isClaimTracked()) {
      analytics.track('claim_started', { entry: 'group_invite', hasGroupInvite: true })
      markClaimTracked()
    }
    if (!state.authenticated && (state.step === ClaimSteps.gate || state.inviteToken !== token)) {
      dispatch({ type: 'reset', state: stateFromPending(null, flags) })
      dispatch({ type: 'chooseJoin', inviteToken: token })
    }
    router.replace(ROUTES.claimCredential)
  }, [ready, token, state, dispatch, flags, analytics, router])

  return (
    <ClaimFrame>
      <Spinner fill label={shellCopy.loading} />
    </ClaimFrame>
  )
}
