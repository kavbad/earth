/**
 * Spec §45 step 6–8, §48, §79, §111: "Prove you're human", the verification session (a hosted
 * step opens in an in-app browser and returns here), the differentiated failures (technical →
 * Try again, inconclusive → Get help verifying, duplicate → "Looks like you're already on
 * Earth."), then `claim_complete()` in one transaction.
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
import { copy, space } from '@earth/ui'
import * as Linking from 'expo-linking'
import { useRouter } from 'expo-router'
import * as WebBrowser from 'expo-web-browser'
import { useEffect, useRef, useState } from 'react'
import { Platform, StyleSheet, View } from 'react-native'

import { useClaimFlow } from '@/components/claim/ClaimFlowProvider'
import { ClaimBody, ClaimFrame, ClaimTitle } from '@/components/claim/ClaimFrame'
import { Button } from '@/components/ui/Button'
import { SegmentedText } from '@/components/ui/SegmentedText'
import { Spinner } from '@/components/ui/Spinner'
import { setCompletion } from '@/lib/claim/completionStore'
import {
  VERIFICATION_POLL_MAX_ATTEMPTS,
  claimStepTitle,
  clearPendingClaim,
  completionRecord,
  failureOutcomeFor,
  isVerificationSettled,
  outcomeFromResult,
  pollDelayMs,
} from '@/lib/claim/flow'
import { clearClaimTracked } from '@/lib/claim/tracking'
import { shellCopy } from '@/lib/copy'
import { deviceStorage } from '@/lib/deviceStorage'
import { errorCode } from '@/lib/errors'
import { lightTap } from '@/lib/haptics'
import { pushPlatformFor } from '@/lib/notifications/push'
import { useAnalytics, useEarth, usePublicEnv, useSession } from '@/lib/providers'
import { ROUTES } from '@/lib/routes'
import { credentialMethod } from '@/lib/session/state'

const MOCK_OPTIONS = MOCK_VERIFICATION_OUTCOMES.map((outcome) => ({ key: outcome, label: outcome }))

export default function ClaimHumanScreen() {
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
    lightTap()
    setBusy(true)
    setError(null)
    try {
      analytics.track('human_verification_started', { attempt })
      verifyingSince.current = Date.now()
      const returnUrl = Linking.createURL(ROUTES.claimHuman)
      const dto = await earth.claim.startVerification({
        platform: pushPlatformFor(Platform.OS),
        returnUrl,
        ...(mockAllowed ? { hint } : {}),
      })
      dispatch({ type: 'verificationStarted', sessionId: dto.sessionId })
      if (dto.providerUrl !== null && dto.status === 'verifying') {
        await WebBrowser.openAuthSessionAsync(dto.providerUrl, returnUrl)
      }
    } catch (cause) {
      setError(
        errorCode(cause) === 'rate_limited' ? shellCopy.tooManyTries : shellCopy.somethingWrong,
      )
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
        setCompletion(completionRecord(completion, state.intent))
        void clearPendingClaim(deviceStorage())
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
      setError(shellCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }

  const title = claimStepTitle(state) ?? copy.proveHuman

  switch (state.step) {
    case 'verifying':
    case 'complete':
      return (
        <ClaimFrame>
          <View style={styles.centered}>
            <Spinner
              label={state.step === 'complete' ? shellCopy.finishingUp : shellCopy.verifying}
            />
            <ClaimBody>
              {state.step === 'complete' ? shellCopy.finishingUp : shellCopy.verifying}
            </ClaimBody>
          </View>
        </ClaimFrame>
      )
    case 'duplicate':
      return (
        <ClaimFrame>
          <ClaimTitle>{copy.alreadyOnEarth}</ClaimTitle>
          <View style={styles.actions}>
            {DUPLICATE_ACTIONS.map((action, index) => (
              <Button
                key={action.event}
                variant={index === 0 ? 'primary' : 'secondary'}
                fullWidth
                loading={busy}
                label={String(copy[action.copyKey])}
                onPress={() => void review(action.event)}
              />
            ))}
          </View>
          {error !== null ? <ClaimBody danger>{error}</ClaimBody> : null}
        </ClaimFrame>
      )
    case 'help':
      return (
        <ClaimFrame>
          <ClaimTitle>{title}</ClaimTitle>
          <ClaimBody>
            {state.helpKind === IdentityReviewKinds.recovery
              ? shellCopy.recoveryRequested
              : state.helpKind === IdentityReviewKinds.safety
                ? shellCopy.safetyRequested
                : shellCopy.helpRequested}
          </ClaimBody>
          <View style={styles.actions}>
            <BackToEarth />
          </View>
        </ClaimFrame>
      )
    default:
      return (
        <ClaimFrame>
          <ClaimTitle>{copy.proveHuman}</ClaimTitle>
          <ClaimBody>{copy.humanExplain}</ClaimBody>
          {state.failure !== null ? (
            <ClaimBody>
              {state.failure.kind === VerificationFailureKinds.technical
                ? shellCopy.verificationTechnical
                : shellCopy.verificationInconclusive}
            </ClaimBody>
          ) : null}
          {mockAllowed ? (
            <View style={styles.mock}>
              <ClaimBody>{shellCopy.mockOutcomeLabel}</ClaimBody>
              <SegmentedText
                label={shellCopy.mockOutcomeLabel}
                options={MOCK_OPTIONS}
                value={hint}
                onSelect={setHint}
              />
            </View>
          ) : null}
          <View style={styles.actions}>
            {state.failure === null ? (
              <Button
                variant="primary"
                fullWidth
                loading={busy}
                label={shellCopy.startVerification}
                onPress={() => void start()}
              />
            ) : state.failure.kind === VerificationFailureKinds.technical ? (
              <Button
                variant="primary"
                fullWidth
                loading={busy}
                label={claimFailureCopy(state.failure.kind)}
                onPress={() => void start()}
              />
            ) : (
              <>
                <Button
                  variant="primary"
                  fullWidth
                  loading={busy}
                  label={claimFailureCopy(state.failure.kind)}
                  onPress={() => void review('needHelp')}
                />
                <Button
                  variant="quiet"
                  fullWidth
                  loading={busy}
                  label={copy.tryAgain}
                  onPress={() => void start()}
                />
              </>
            )}
          </View>
          {error !== null ? <ClaimBody danger>{error}</ClaimBody> : null}
        </ClaimFrame>
      )
  }
}

function BackToEarth() {
  const router = useRouter()
  return (
    <Button
      variant="quiet"
      fullWidth
      label={shellCopy.backToEarth}
      onPress={() => router.replace(ROUTES.home)}
    />
  )
}

const styles = StyleSheet.create({
  centered: { alignItems: 'center', gap: space[3], paddingVertical: space[8] },
  actions: { gap: space[2], marginTop: space[4] },
  mock: { gap: space[2], marginTop: space[2] },
})
