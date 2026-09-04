'use client'

/**
 * Spec §45 step 6–8, §48, §79, §111: "Prove you're human", the verification session, the
 * differentiated failures (technical → Try again, inconclusive → Get help verifying, duplicate →
 * "Looks like you're already on Earth."), then `claim_complete()` in one transaction.
 */
import {
  DUPLICATE_ACTIONS,
  type DuplicateActionEvent,
  IdentityReviewKinds,
  MOCK_VERIFICATION_OUTCOMES,
  type MockVerificationOutcome,
  VerificationFailureKinds,
  claimFailureCopy,
  isMockAllowedAppEnv,
} from '@earth/auth'
import { copy } from '@earth/ui'
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { Button } from '../../../components/ui/Button'
import { Spinner } from '../../../components/ui/Spinner'
import {
  VERIFICATION_POLL_MAX_ATTEMPTS,
  claimStepTitle,
  clearPendingClaim,
  failureOutcomeFor,
  isVerificationSettled,
  outcomeFromResult,
  pollDelayMs,
  writeCompletion,
} from '../../../lib/claim/flow'
import { clearClaimTracked } from '../../../lib/claim/tracking'
import { webCopy } from '../../../lib/copy'
import { errorCode } from '../../../lib/errors'
import { useAnalytics } from '../../../lib/providers/AnalyticsProvider'
import { useEarth, usePublicEnv } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'
import { ROUTES } from '../../../lib/routes'
import { credentialMethod } from '../../../lib/session/state'
import { sessionStore } from '../../../lib/storage'
import { useClaimFlow } from '../_components/ClaimFlowProvider'
import { ClaimTitle } from '../_components/ClaimFrame'

export default function ClaimHumanPage() {
  const { state, dispatch, getStartedAt } = useClaimFlow()
  const earth = useEarth()
  const env = usePublicEnv()
  const session = useSession()
  const analytics = useAnalytics()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<MockVerificationOutcome>('verified')
  const verifyingSince = useRef<number | null>(null)
  const completing = useRef(false)
  const mockAllowed = env !== null && isMockAllowedAppEnv(env.APP_ENV)

  const attempt = state.verification.attempts + 1

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      analytics.track('human_verification_started', { attempt })
      verifyingSince.current = Date.now()
      const dto = await earth.claim.startVerification({
        platform: 'web',
        returnUrl: window.location.href,
        ...(mockAllowed ? { hint } : {}),
      })
      dispatch({ type: 'verificationStarted', sessionId: dto.sessionId })
      if (dto.providerUrl !== null && dto.status === 'verifying') {
        window.location.assign(dto.providerUrl)
      }
    } catch (cause) {
      setError(errorCode(cause) === 'rate_limited' ? webCopy.tooManyTries : webCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }

  // Poll the result while verifying (spec §45 step 7).
  useEffect(() => {
    if (state.step !== 'verifying') return
    const sessionId = state.verification.sessionId
    if (sessionId === null) return
    let cancelled = false
    let attempts = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      if (cancelled) return
      attempts += 1
      try {
        const result = await earth.claim.pollVerification(sessionId)
        if (cancelled) return
        if (isVerificationSettled(result.status)) {
          const outcome = outcomeFromResult(result)
          const durationMs = Date.now() - (verifyingSince.current ?? Date.now())
          if (result.status === 'verified') {
            analytics.track('human_verification_passed', { attempt, durationMs })
          } else {
            const failed = failureOutcomeFor(result.status)
            if (failed !== null)
              analytics.track('human_verification_failed', { attempt, outcome: failed })
          }
          dispatch({ type: 'verificationResult', result: outcome })
          return
        }
      } catch {
        // A failed poll is retried; only exhaustion becomes a technical failure.
      }
      if (attempts >= VERIFICATION_POLL_MAX_ATTEMPTS) {
        dispatch({
          type: 'verificationResult',
          result: { status: 'unverified', failureKind: VerificationFailureKinds.technical },
        })
        return
      }
      timer = setTimeout(() => void tick(), pollDelayMs(attempts))
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [state.step, state.verification.sessionId, earth, dispatch, analytics, attempt])

  // `claim_complete()`: Human + group + membership + conversation in one transaction.
  useEffect(() => {
    if (state.step !== 'complete' || completing.current) return
    completing.current = true
    const run = async () => {
      try {
        const completion = await earth.claim.complete()
        const durationMs = Date.now() - getStartedAt()
        if (state.intent !== null) {
          analytics.track('human_claimed', {
            intent: state.intent,
            groupId: completion.groupId,
            durationMs,
          })
        }
        if (state.intent === 'start_group') {
          analytics.track('group_created', {
            groupId: completion.groupId,
            kind: 'persistent',
            duringClaim: true,
          })
        } else if (state.intent === 'join_group') {
          analytics.track('group_joined', {
            groupId: completion.groupId,
            viaInvite: true,
            duringClaim: true,
            memberGroupCount: 1,
          })
        }
        writeCompletion(sessionStore(), completion, state.intent)
        clearPendingClaim(sessionStore())
        clearClaimTracked()
        await session.refresh()
        dispatch({ type: 'completed', completion })
      } catch (cause) {
        completing.current = false
        dispatch({ type: 'completeFailed', code: errorCode(cause) })
      }
    }
    void run()
  }, [state.step, state.intent, earth, analytics, session, dispatch, getStartedAt])

  const review = async (event: DuplicateActionEvent | 'needHelp') => {
    setBusy(true)
    setError(null)
    try {
      const action = DUPLICATE_ACTIONS.find((candidate) => candidate.event === event)
      const kind = action?.reviewKind ?? IdentityReviewKinds.inconclusive
      await earth.claim.createReview({ kind })
      if (event === 'recover') {
        analytics.track('account_recovery_started', {
          method: credentialMethod(session.session) ?? 'email',
        })
      }
      dispatch({ type: event })
    } catch {
      setError(webCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }

  const title = claimStepTitle(state) ?? copy.proveHuman

  switch (state.step) {
    case 'verifying':
    case 'complete':
      return (
        <div className="flex flex-col items-center gap-4 py-8 text-center">
          <Spinner />
          <p className="text-body text-text-secondary">
            {state.step === 'complete' ? webCopy.finishingUp : webCopy.verifying}
          </p>
        </div>
      )
    case 'duplicate':
      return (
        <>
          <ClaimTitle>{copy.alreadyOnEarth}</ClaimTitle>
          <div className="flex flex-col gap-2">
            {DUPLICATE_ACTIONS.map((action, index) => (
              <Button
                key={action.event}
                variant={index === 0 ? 'primary' : 'secondary'}
                fullWidth
                loading={busy}
                onClick={() => void review(action.event)}
              >
                {String(copy[action.copyKey])}
              </Button>
            ))}
          </div>
          {error !== null ? (
            <p role="alert" className="mt-3 text-secondary text-danger">
              {error}
            </p>
          ) : null}
        </>
      )
    case 'help':
      return (
        <>
          <ClaimTitle>{title}</ClaimTitle>
          <p className="text-body text-text-secondary">
            {state.helpKind === IdentityReviewKinds.recovery
              ? webCopy.recoveryRequested
              : state.helpKind === IdentityReviewKinds.safety
                ? webCopy.safetyRequested
                : webCopy.helpRequested}
          </p>
          <Link href={ROUTES.home} className="mt-6 text-body text-earth-accent">
            {webCopy.backToEarth}
          </Link>
        </>
      )
    default:
      return (
        <>
          <ClaimTitle>{copy.proveHuman}</ClaimTitle>
          <p className="text-body text-text-secondary">{copy.humanExplain}</p>
          {state.failure !== null ? (
            <p role="alert" className="mt-4 text-body">
              {state.failure.kind === VerificationFailureKinds.technical
                ? webCopy.verificationTechnical
                : webCopy.verificationInconclusive}
            </p>
          ) : null}
          {mockAllowed ? (
            <label className="mt-4 flex flex-col gap-1 text-secondary text-text-secondary">
              {webCopy.mockOutcomeLabel}
              <select
                value={hint}
                onChange={(event) => setHint(event.target.value as MockVerificationOutcome)}
                className="min-h-touch-target rounded-medium bg-subtle-fill px-4 text-body text-text-primary"
              >
                {MOCK_VERIFICATION_OUTCOMES.map((outcome) => (
                  <option key={outcome} value={outcome}>
                    {outcome}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="mt-6 flex flex-col gap-2">
            {state.failure === null ? (
              <Button variant="primary" fullWidth loading={busy} onClick={() => void start()}>
                {webCopy.startVerification}
              </Button>
            ) : state.failure.kind === VerificationFailureKinds.technical ? (
              <Button variant="primary" fullWidth loading={busy} onClick={() => void start()}>
                {claimFailureCopy(state.failure.kind)}
              </Button>
            ) : (
              <>
                <Button
                  variant="primary"
                  fullWidth
                  loading={busy}
                  onClick={() => void review('needHelp')}
                >
                  {claimFailureCopy(state.failure.kind)}
                </Button>
                <Button variant="quiet" fullWidth loading={busy} onClick={() => void start()}>
                  {copy.tryAgain}
                </Button>
              </>
            )}
          </div>
          {error !== null ? (
            <p role="alert" className="mt-3 text-secondary text-danger">
              {error}
            </p>
          ) : null}
        </>
      )
  }
}
