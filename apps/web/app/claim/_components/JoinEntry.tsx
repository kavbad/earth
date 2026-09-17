'use client'

import { ClaimSteps } from '@earth/auth'
import { useRouter } from 'next/navigation'
import { useEffect, useRef } from 'react'

import { Spinner } from '../../../components/ui/Spinner'
import { stateFromPending } from '../../../lib/claim/flow'
import { isClaimTracked, markClaimTracked } from '../../../lib/claim/tracking'
import { useAnalytics } from '../../../lib/providers/AnalyticsProvider'
import { ROUTES } from '../../../lib/routes'
import { useClaimFlow } from './ClaimFlowProvider'

export function JoinEntry({ token }: { readonly token: string | null }) {
  const { state, ready, dispatch, flags } = useClaimFlow()
  const analytics = useAnalytics()
  const router = useRouter()
  const handled = useRef(false)

  useEffect(() => {
    if (!ready || handled.current) return
    handled.current = true
    if (token === null || token === '') {
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
    <div className="flex flex-1 items-center justify-center">
      <Spinner />
    </div>
  )
}
