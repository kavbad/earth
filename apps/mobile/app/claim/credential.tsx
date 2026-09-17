/**
 * Spec §45 step 4 / §46 step 3: the credential — email or phone OTP, the code typed in the app.
 * A person who already holds a credential (a signed-in Human) skips the code; existing Humans
 * are routed by the flow provider (spec §47).
 */
import { isAnonymousSession } from '@earth/auth'
import { copy, space } from '@earth/ui'
import { useEffect, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'

import { useClaimFlow } from '@/components/claim/ClaimFlowProvider'
import { ClaimBody, ClaimFrame, ClaimTitle } from '@/components/claim/ClaimFrame'
import { Button } from '@/components/ui/Button'
import { SegmentedText } from '@/components/ui/SegmentedText'
import { TextField } from '@/components/ui/TextField'
import { claimStepTitle } from '@/lib/claim/flow'
import { shellCopy } from '@/lib/copy'
import { errorCode } from '@/lib/errors'
import { lightTap } from '@/lib/haptics'
import { useRuntime, useSession } from '@/lib/providers'

type Method = 'email' | 'phone'
type Phase = 'enter' | 'code' | 'resolving'

const METHOD_OPTIONS = [
  { key: 'email', label: shellCopy.email },
  { key: 'phone', label: shellCopy.phone },
] as const

/** GoTrue's default six digits (spec §45 step 4); the field submits itself when full. */
const OTP_CODE_LENGTH = 6

function isCodeComplete(value: string): boolean {
  return value.replace(/\s/g, '').length === OTP_CODE_LENGTH
}

function messageFor(code: string): string {
  switch (code) {
    case 'rate_limited':
      return shellCopy.tooManyTries
    case 'invalid_input':
      return shellCopy.checkAddress
    case 'invite_invalid':
    case 'invite_exhausted':
      return shellCopy.inviteInvalid
    case 'invite_expired':
      return shellCopy.inviteExpired
    default:
      return shellCopy.somethingWrong
  }
}

export default function ClaimCredentialScreen() {
  const { state, ready, resolveCredential } = useClaimFlow()
  const { runtime } = useRuntime()
  const session = useSession()
  const [method, setMethod] = useState<Method>('email')
  const [destination, setDestination] = useState('')
  const [code, setCode] = useState('')
  const [phase, setPhase] = useState<Phase>('enter')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [autoFailed, setAutoFailed] = useState(false)
  const autoResolved = useRef(false)

  // A real credential already exists (returning person): no code to type.
  const autoResolving =
    ready &&
    session.status === 'ready' &&
    session.session !== null &&
    !isAnonymousSession(session.session) &&
    !autoFailed

  useEffect(() => {
    if (!autoResolving || autoResolved.current) return
    autoResolved.current = true
    void resolveCredential().then((result) => {
      if (!result.ok) {
        setError(messageFor(result.code))
        setAutoFailed(true)
      }
    })
  }, [autoResolving, resolveCredential])

  const sendCode = async () => {
    if (runtime === null || destination.trim() === '') return
    lightTap()
    setBusy(true)
    setError(null)
    try {
      if (method === 'email') await runtime.session.signInWithEmailOtp(destination)
      else await runtime.session.signInWithPhoneOtp(destination)
      setPhase('code')
    } catch (cause) {
      setError(messageFor(errorCode(cause)))
    } finally {
      setBusy(false)
    }
  }

  const verify = async (value: string = code) => {
    if (runtime === null || busy || !isCodeComplete(value)) return
    lightTap()
    setBusy(true)
    setError(null)
    try {
      await runtime.session.verifyOtp(
        method === 'email'
          ? { email: destination, token: value }
          : { phone: destination, token: value },
      )
      autoResolved.current = true
      setPhase('resolving')
      const result = await resolveCredential()
      if (!result.ok) {
        setError(messageFor(result.code))
        setPhase('enter')
      }
    } catch (cause) {
      const codeOf = errorCode(cause)
      setError(codeOf === 'invalid_input' ? shellCopy.codeInvalid : messageFor(codeOf))
    } finally {
      setBusy(false)
    }
  }

  const title = claimStepTitle(state) ?? copy.claimYourPlace

  if (phase === 'resolving' || autoResolving) {
    return (
      <ClaimFrame>
        <ClaimTitle>{title}</ClaimTitle>
        <Button
          variant="primary"
          fullWidth
          loading
          label={shellCopy.continue}
          onPress={() => undefined}
        />
      </ClaimFrame>
    )
  }

  if (phase === 'code') {
    return (
      <ClaimFrame>
        <ClaimTitle>{title}</ClaimTitle>
        <View style={styles.form}>
          <ClaimBody>{shellCopy.codeSent(destination)}</ClaimBody>
          <TextField
            label={shellCopy.codeLabel}
            value={code}
            onChangeText={(next) => {
              setCode(next)
              if (isCodeComplete(next)) void verify(next)
            }}
            error={error}
            maxLength={OTP_CODE_LENGTH}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            autoFocus
            returnKeyType="go"
            onSubmitEditing={() => void verify()}
          />
          <Button
            variant="primary"
            fullWidth
            loading={busy}
            disabled={!isCodeComplete(code)}
            label={shellCopy.continue}
            onPress={() => void verify()}
          />
          <Button
            variant="quiet"
            fullWidth
            label={shellCopy.useDifferent}
            onPress={() => {
              setPhase('enter')
              setError(null)
            }}
          />
        </View>
      </ClaimFrame>
    )
  }

  return (
    <ClaimFrame>
      <ClaimTitle>{title}</ClaimTitle>
      <View style={styles.form}>
        <SegmentedText
          label={shellCopy.signInMethod}
          options={METHOD_OPTIONS}
          value={method}
          onSelect={(next) => {
            setMethod(next)
            setError(null)
          }}
        />
        {method === 'email' ? (
          <TextField
            label={shellCopy.emailLabel}
            value={destination}
            onChangeText={setDestination}
            error={error}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            textContentType="emailAddress"
            autoFocus
            returnKeyType="send"
            onSubmitEditing={() => void sendCode()}
          />
        ) : (
          <TextField
            label={shellCopy.phoneLabel}
            hint={shellCopy.phoneHint}
            value={destination}
            onChangeText={setDestination}
            error={error}
            keyboardType="phone-pad"
            autoComplete="tel"
            textContentType="telephoneNumber"
            autoFocus
            returnKeyType="send"
            onSubmitEditing={() => void sendCode()}
          />
        )}
        <Button
          variant="primary"
          fullWidth
          loading={busy}
          disabled={destination.trim() === ''}
          label={shellCopy.sendCode}
          onPress={() => void sendCode()}
        />
      </View>
    </ClaimFrame>
  )
}

const styles = StyleSheet.create({
  form: { gap: space[4] },
})
