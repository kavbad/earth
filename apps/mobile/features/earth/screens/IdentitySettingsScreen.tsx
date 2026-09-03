/**
 * SCREEN 25 → Human identity: Human Pass status (spec §19, §77–§80), the privacy line, and the
 * two doors when something is off — "Get help verifying" (a `help` review, spec §79) and
 * "Recover your place" (a `recovery` review, spec §80; `account_recovery_started`).
 */
import { IdentityReviewKinds } from '@earth/auth'
import { copy, space } from '@earth/ui'
import { useReducer } from 'react'
import { StyleSheet, View } from 'react-native'

import { Button } from '@/components/ui/Button'
import { ListRow } from '@/components/ui/ListRow'

import { youCopy } from '../copy'
import { messageForError } from '../errors'
import { lightTap } from '../haptics'
import { useEarthShell } from '../shell'
import { credentialMethod, initialRequestState, requestReducer } from '../state/settings'
import {
  InlineError,
  SettingsBody,
  SettingsFrame,
  SettingsSection,
  StatusText,
  useSettingsBack,
} from './SettingsFrame'

const items = copy.settings.sections.humanIdentity.items

type Requested = 'help' | 'recovery'

export function IdentitySettingsScreen() {
  const shell = useEarthShell()
  const { earth, track } = shell
  const back = useSettingsBack()
  const [state, dispatch] = useReducer(requestReducer<Requested>, undefined, () =>
    initialRequestState<Requested>(),
  )
  const status = shell.me?.humanPassStatus ?? null

  const request = async (kind: Requested) => {
    if (state.busy !== null) return
    lightTap()
    dispatch({ type: 'start', kind })
    try {
      await earth.claim.createReview({
        kind: kind === 'help' ? IdentityReviewKinds.help : IdentityReviewKinds.recovery,
        details: { source: 'settings' },
      })
      if (kind === 'recovery') {
        track('account_recovery_started', {
          method: credentialMethod(shell.authSession) ?? 'email',
        })
      }
      dispatch({ type: 'done', kind })
    } catch (cause) {
      dispatch({ type: 'failed', error: messageForError(cause) })
    }
  }

  return (
    <SettingsFrame title={copy.settings.sections.humanIdentity.title} onBack={back}>
      <SettingsSection title={items.humanPassStatus} hint={copy.verificationPrivacy}>
        <ListRow
          title={items.humanPassStatus}
          subtitle={status === null ? undefined : youCopy.humanPass[status]}
          separator={false}
        />
      </SettingsSection>
      <SettingsSection title={items.recoveryAndHelp} hint={youCopy.recoveryLine}>
        <SettingsBody>
          {state.done !== null ? (
            <StatusText>
              {state.done === 'help' ? youCopy.helpRequested : youCopy.recoveryRequested}
            </StatusText>
          ) : (
            <View style={styles.actions}>
              {status !== 'verified' ? (
                <Button
                  variant="primary"
                  loading={state.busy === 'help'}
                  label={copy.getHelpVerifying}
                  onPress={() => void request('help')}
                />
              ) : null}
              <Button
                variant="secondary"
                loading={state.busy === 'recovery'}
                label={copy.recoverYourPlace}
                onPress={() => void request('recovery')}
              />
            </View>
          )}
          <InlineError message={state.error} />
        </SettingsBody>
      </SettingsSection>
    </SettingsFrame>
  )
}

const styles = StyleSheet.create({
  actions: { alignItems: 'flex-start', gap: space[2] },
})
