/** Spec §44 — the launch membership gate: "Earth starts with your people." */
import { CLAIM_FLAG_KEY, type ClaimEvent, ClaimSteps } from '@earth/auth'
import { copy, space } from '@earth/ui'
import { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { useClaimFlow } from '@/components/claim/ClaimFlowProvider'
import { ClaimFrame, ClaimTitle } from '@/components/claim/ClaimFrame'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/TextField'
import { parseInviteToken, stateFromPending } from '@/lib/claim/flow'
import { isClaimTracked, markClaimTracked } from '@/lib/claim/tracking'
import { shellCopy } from '@/lib/copy'
import { lightTap } from '@/lib/haptics'
import { useAnalytics } from '@/lib/providers'

export default function ClaimGateScreen() {
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

  const onJoin = () => {
    const token = parseInviteToken(invite)
    if (token === null) {
      setInviteError(shellCopy.inviteInvalid)
      return
    }
    setInviteError(null)
    lightTap()
    analytics.track('claim_group_join_selected', {})
    choose({ type: 'chooseJoin', inviteToken: token })
  }

  const onStart = () => {
    lightTap()
    analytics.track('claim_group_start_selected', {})
    choose({ type: 'chooseStart' })
  }

  return (
    <ClaimFrame>
      <ClaimTitle>{copy.claimGate}</ClaimTitle>
      <View style={styles.actions}>
        {joining ? (
          <>
            <TextField
              label={shellCopy.inviteLinkLabel}
              hint={shellCopy.inviteLinkHint}
              value={invite}
              onChangeText={setInvite}
              error={inviteError}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={onJoin}
            />
            <Button
              variant="primary"
              fullWidth
              label={copy.joinThem}
              onPress={onJoin}
              disabled={invite.trim() === ''}
            />
            <Button
              variant="quiet"
              fullWidth
              label={shellCopy.back}
              onPress={() => setJoining(false)}
            />
          </>
        ) : (
          <>
            <Button
              variant="secondary"
              fullWidth
              label={copy.joinGroup}
              onPress={() => setJoining(true)}
            />
            <Button variant="primary" fullWidth label={copy.startGroup} onPress={onStart} />
            {flags[CLAIM_FLAG_KEY] ? null : (
              <Button
                variant="quiet"
                fullWidth
                label={shellCopy.continueWithoutGroup}
                onPress={() => choose({ type: 'continueWithoutGroup' })}
              />
            )}
          </>
        )}
      </View>
    </ClaimFrame>
  )
}

const styles = StyleSheet.create({
  actions: { gap: space[3] },
})
