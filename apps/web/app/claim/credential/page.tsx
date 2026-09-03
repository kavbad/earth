'use client'

/**
 * Spec §45 step 4 / §46 step 3: the credential — email or phone OTP. A person who already holds
 * a credential (the OTP link, a signed-in Human) skips the code; existing Humans are routed by
 * the flow provider (spec §47).
 */
import { isAnonymousSession } from '@earth/auth'
import { copy } from '@earth/ui'
import { type FormEvent, useEffect, useRef, useState } from 'react'

import { Button } from '../../../components/ui/Button'
import { SegmentedText } from '../../../components/ui/SegmentedText'
import { TextField } from '../../../components/ui/TextField'
import { claimStepTitle } from '../../../lib/claim/flow'
import { webCopy } from '../../../lib/copy'
import { errorCode } from '../../../lib/errors'
import { useRuntime } from '../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../lib/providers/SessionProvider'
import { ROUTES, authCallbackRoute } from '../../../lib/routes'
import { useClaimFlow } from '../_components/ClaimFlowProvider'
import { ClaimTitle } from '../_components/ClaimFrame'

type Method = 'email' | 'phone'
type Phase = 'enter' | 'code' | 'resolving'

const METHOD_OPTIONS = [
  { key: 'email', label: webCopy.email },
  { key: 'phone', label: webCopy.phone },
] as const

function messageFor(code: string): string {
  switch (code) {
    case 'rate_limited':
      return webCopy.tooManyTries
    case 'invalid_input':
      return webCopy.checkAddress
    case 'invite_invalid':
    case 'invite_exhausted':
      return webCopy.inviteInvalid
    case 'invite_expired':
      return webCopy.inviteExpired
    default:
      return webCopy.somethingWrong
  }
}

export default function ClaimCredentialPage() {
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

  // A real credential already exists (OTP link, returning person): no code to type.
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

  const sendCode = async (event: FormEvent) => {
    event.preventDefault()
    if (runtime === null) return
    setBusy(true)
    setError(null)
    try {
      if (method === 'email') {
        const next = authCallbackRoute(ROUTES.claimCredential)
        await runtime.session.signInWithEmailOtp(destination, {
          emailRedirectTo: `${window.location.origin}${next}`,
        })
      } else {
        await runtime.session.signInWithPhoneOtp(destination)
      }
      setPhase('code')
    } catch (cause) {
      setError(messageFor(errorCode(cause)))
    } finally {
      setBusy(false)
    }
  }

  const verify = async (event: FormEvent) => {
    event.preventDefault()
    if (runtime === null) return
    setBusy(true)
    setError(null)
    try {
      await runtime.session.verifyOtp(
        method === 'email'
          ? { email: destination, token: code }
          : { phone: destination, token: code },
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
      setError(codeOf === 'invalid_input' ? webCopy.codeInvalid : messageFor(codeOf))
    } finally {
      setBusy(false)
    }
  }

  const title = claimStepTitle(state) ?? copy.claimYourPlace

  if (phase === 'resolving' || autoResolving) {
    return (
      <>
        <ClaimTitle>{title}</ClaimTitle>
        <Button variant="primary" fullWidth loading>
          {webCopy.continue}
        </Button>
      </>
    )
  }

  if (phase === 'code') {
    return (
      <form onSubmit={verify} className="flex flex-col gap-3">
        <ClaimTitle>{title}</ClaimTitle>
        <p className="text-secondary text-text-secondary">{webCopy.codeSent(destination)}</p>
        <TextField
          label={webCopy.codeLabel}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          error={error}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
        />
        <Button
          type="submit"
          variant="primary"
          fullWidth
          loading={busy}
          disabled={code.trim().length < 4}
        >
          {webCopy.continue}
        </Button>
        <Button variant="quiet" fullWidth onClick={() => setPhase('enter')}>
          {webCopy.useDifferent}
        </Button>
      </form>
    )
  }

  return (
    <form onSubmit={sendCode} className="flex flex-col gap-4">
      <ClaimTitle>{title}</ClaimTitle>
      <SegmentedText
        label={webCopy.signInMethod}
        options={METHOD_OPTIONS}
        value={method}
        onSelect={(next) => {
          setMethod(next)
          setError(null)
        }}
      />
      {method === 'email' ? (
        <TextField
          label={webCopy.emailLabel}
          type="email"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          error={error}
          autoComplete="email"
          inputMode="email"
          autoFocus
        />
      ) : (
        <TextField
          label={webCopy.phoneLabel}
          type="tel"
          hint={webCopy.phoneHint}
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          error={error}
          autoComplete="tel"
          inputMode="tel"
          autoFocus
        />
      )}
      <Button
        type="submit"
        variant="primary"
        fullWidth
        loading={busy}
        disabled={destination.trim() === ''}
      >
        {webCopy.sendCode}
      </Button>
    </form>
  )
}
