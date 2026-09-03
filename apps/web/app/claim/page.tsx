'use client'

/** Spec §44 — the launch membership gate: "Earth starts with your people." */
import { CLAIM_FLAG_KEY, type ClaimEvent, ClaimSteps } from '@earth/auth'
import { copy } from '@earth/ui'
import { type FormEvent, useEffect, useState } from 'react'

import { Button } from '../../components/ui/Button'
import { TextField } from '../../components/ui/TextField'
import { parseInviteToken, stateFromPending } from '../../lib/claim/flow'
import { isClaimTracked, markClaimTracked } from '../../lib/claim/tracking'
import { webCopy } from '../../lib/copy'
import { useAnalytics } from '../../lib/providers/AnalyticsProvider'
import { useClaimFlow } from './_components/ClaimFlowProvider'
import { ClaimTitle } from './_components/ClaimFrame'

export default function ClaimGatePage() {
  const { state, dispatch, flags } = useClaimFlow()
  const analytics = useAnalytics()
  const [joining, setJoining] = useState(false)
  const [invite, setInvite] = useState('')
  const [inviteError, setInviteError] = useState<string | null>(null)

  useEffect(() => {
    if (isClaimTracked()) return
    analytics.track('claim_started', { entry: 'launch', hasGroupInvite: false })
    markClaimTracked()
  }, [analytics])

  /** Coming back to the gate re-opens the choice (the reducer ignores events after `gate`). */
  const choose = (event: ClaimEvent) => {
    if (state.step !== ClaimSteps.gate) {
      dispatch({ type: 'reset', state: stateFromPending(null, flags) })
    }
    dispatch(event)
  }

  const onJoin = (event: FormEvent) => {
    event.preventDefault()
    const token = parseInviteToken(invite)
    if (token === null) {
      setInviteError(webCopy.inviteInvalid)
      return
    }
    setInviteError(null)
    analytics.track('claim_group_join_selected', {})
    choose({ type: 'chooseJoin', inviteToken: token })
  }

  const onStart = () => {
    analytics.track('claim_group_start_selected', {})
    choose({ type: 'chooseStart' })
  }

  return (
    <>
      <ClaimTitle>{copy.claimGate}</ClaimTitle>
      <div className="flex flex-col gap-3">
        {joining ? (
          <form onSubmit={onJoin} className="flex flex-col gap-3">
            <TextField
              label={webCopy.inviteLinkLabel}
              hint={webCopy.inviteLinkHint}
              value={invite}
              onChange={(event) => setInvite(event.target.value)}
              error={inviteError}
              autoFocus
              autoComplete="off"
              inputMode="url"
            />
            <Button type="submit" variant="primary" fullWidth disabled={invite.trim() === ''}>
              {copy.joinThem}
            </Button>
            <Button variant="quiet" fullWidth onClick={() => setJoining(false)}>
              {webCopy.back}
            </Button>
          </form>
        ) : (
          <>
            <Button variant="secondary" fullWidth onClick={() => setJoining(true)}>
              {copy.joinGroup}
            </Button>
            <Button variant="primary" fullWidth onClick={onStart}>
              {copy.startGroup}
            </Button>
            {flags[CLAIM_FLAG_KEY] ? null : (
              <Button
                variant="quiet"
                fullWidth
                onClick={() => choose({ type: 'continueWithoutGroup' })}
              >
                {webCopy.continueWithoutGroup}
              </Button>
            )}
          </>
        )}
      </div>
    </>
  )
}
