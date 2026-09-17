'use client'

/**
 * SCREEN 25 → Human identity: Human Pass status (spec §19, §77–§80), the privacy line, and the
 * two doors when something is off — "Get help verifying" (a `help` review, spec §79) and
 * "Recover your place" (a `recovery` review, spec §80; `account_recovery_started`).
 */
import { IdentityReviewKinds } from '@earth/auth'
import { copy } from '@earth/ui'
import { useState } from 'react'

import { Button } from '../../../../../components/ui/Button'
import { List, ListRow } from '../../../../../components/ui/ListRow'
import { webCopy } from '../../../../../lib/copy'
import { errorCode } from '../../../../../lib/errors'
import { useAnalytics } from '../../../../../lib/providers/AnalyticsProvider'
import { useEarth } from '../../../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../../../lib/providers/SessionProvider'
import { credentialMethod } from '../../../../../lib/session/state'
import { youCopy } from '../../_lib/copy'
import { SettingsSection } from './SettingsFrame'

const items = copy.settings.sections.humanIdentity.items

type Requested = 'none' | 'help' | 'recovery'

export function IdentitySettings() {
  const earth = useEarth()
  const session = useSession()
  const analytics = useAnalytics()
  const [busy, setBusy] = useState<Requested>('none')
  const [requested, setRequested] = useState<Requested>('none')
  const [error, setError] = useState<string | null>(null)
  const status = session.me?.humanPassStatus ?? null

  const request = async (kind: Exclude<Requested, 'none'>) => {
    setBusy(kind)
    setError(null)
    try {
      await earth.claim.createReview({
        kind: kind === 'help' ? IdentityReviewKinds.help : IdentityReviewKinds.recovery,
        details: { source: 'settings' },
      })
      if (kind === 'recovery') {
        analytics.track('account_recovery_started', {
          method: credentialMethod(session.session) ?? 'email',
        })
      }
      setRequested(kind)
    } catch (cause) {
      setError(errorCode(cause) === 'rate_limited' ? webCopy.tooManyTries : webCopy.somethingWrong)
    } finally {
      setBusy('none')
    }
  }

  return (
    <>
      <SettingsSection title={items.humanPassStatus} hint={copy.verificationPrivacy}>
        <List>
          <ListRow
            title={items.humanPassStatus}
            trailing={status === null ? '' : youCopy.humanPass[status]}
          />
        </List>
      </SettingsSection>
      <SettingsSection title={items.recoveryAndHelp} hint={youCopy.recoveryLine}>
        <div className="flex flex-col items-start gap-3 px-screen-margin">
          {requested !== 'none' ? (
            <p role="status" className="text-body">
              {requested === 'help' ? youCopy.helpRequested : youCopy.recoveryRequested}
            </p>
          ) : (
            <>
              {status !== 'verified' ? (
                <Button
                  variant="primary"
                  loading={busy === 'help'}
                  onClick={() => void request('help')}
                >
                  {copy.getHelpVerifying}
                </Button>
              ) : null}
              <Button
                variant="secondary"
                loading={busy === 'recovery'}
                onClick={() => void request('recovery')}
              >
                {copy.recoverYourPlace}
              </Button>
            </>
          )}
          {error !== null ? (
            <p role="alert" className="text-secondary text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </SettingsSection>
    </>
  )
}
