'use client'

/**
 * SCREEN 25 → Account: display identity, handle (availability shown; changing is not offered by
 * the server yet), access credentials (email / phone, add one by code), recovery (spec §80) and
 * "Delete my account" (a `help` review with `{ action: 'delete' }`, then sign-out).
 */
import { IdentityReviewKinds } from '@earth/auth'
import { BIO_MAX, DISPLAY_NAME_MAX } from '@earth/domain'
import { copy, formatHandle } from '@earth/ui'
import { useRouter } from 'next/navigation'
import { type ChangeEvent, type FormEvent, useEffect, useReducer, useRef, useState } from 'react'

import { Avatar } from '../../../../../components/ui/Avatar'
import { Button } from '../../../../../components/ui/Button'
import { List, ListRow } from '../../../../../components/ui/ListRow'
import { Sheet } from '../../../../../components/ui/Sheet'
import { TextArea } from '../../../../../components/ui/TextArea'
import { TextField } from '../../../../../components/ui/TextField'
import { useToast } from '../../../../../components/ui/Toast'
import { webCopy } from '../../../../../lib/copy'
import { errorCode } from '../../../../../lib/errors'
import { useAnalytics } from '../../../../../lib/providers/AnalyticsProvider'
import { useEarth, useRuntime } from '../../../../../lib/providers/RuntimeProvider'
import { useSession } from '../../../../../lib/providers/SessionProvider'
import { ROUTES } from '../../../../../lib/routes'
import { credentialMethod } from '../../../../../lib/session/state'
import { youCopy } from '../../_lib/copy'
import { startCredentialChange, verifyCredentialChange } from '../_lib/credentials'
import {
  type CredentialMethod,
  DELETE_ACCOUNT_REVIEW,
  credentialFlowReducer,
  credentialsFrom,
  handleCheckReducer,
  handleNeedsCheck,
  identityFormError,
  identityFormReducer,
  identityUpdatePayload,
  initialCredentialFlow,
  initialHandleCheck,
  initialIdentityForm,
} from '../_lib/settings'
import { SettingsSection } from './SettingsFrame'

export const HANDLE_CHECK_DEBOUNCE_MS = 400

const items = copy.settings.sections.account.items

export function AccountSettings() {
  const identity = useSession().identity
  if (identity === null) return null
  return (
    <>
      <DisplayIdentity
        displayName={identity.displayName}
        bio={identity.bio}
        avatarUrl={identity.avatarUrl}
      />
      <HandleRow current={identity.handle} />
      <AccessCredentials />
      <Recovery />
      <DeleteAccount />
    </>
  )
}

function DisplayIdentity({
  displayName,
  bio,
  avatarUrl,
}: {
  displayName: string
  bio: string | null
  avatarUrl: string | null
}) {
  const earth = useEarth()
  const session = useSession()
  const toast = useToast()
  const [form, dispatch] = useReducer(identityFormReducer, undefined, () =>
    initialIdentityForm(displayName, bio),
  )
  const baseline = useRef({ displayName, bio })
  const fileInput = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  useEffect(() => {
    if (baseline.current.displayName === displayName && baseline.current.bio === bio) return
    baseline.current = { displayName, bio }
    dispatch({ type: 'reset', displayName, bio })
  }, [displayName, bio])

  const validation = identityFormError(form)
  const payload = identityUpdatePayload(form, { displayName, bio })
  const dirty = Object.keys(payload).length > 0

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (validation !== null || !dirty) return
    dispatch({ type: 'saving' })
    try {
      await earth.identity.update(payload)
      await session.refresh()
      dispatch({ type: 'saved', at: Date.now() })
      toast.show(youCopy.saved)
    } catch (cause) {
      dispatch({
        type: 'failed',
        error: errorCode(cause) === 'rate_limited' ? webCopy.tooManyTries : webCopy.somethingWrong,
      })
    }
  }

  const choosePhoto = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setUploading(true)
    try {
      const media = await earth.identity.uploadAvatar({
        body: file,
        contentType: file.type,
        byteSize: file.size,
      })
      await earth.identity.update({ avatarMediaId: media.id })
      await session.refresh()
      toast.show(youCopy.saved)
    } catch {
      toast.show(webCopy.somethingWrong)
    } finally {
      setUploading(false)
    }
  }

  return (
    <SettingsSection title={items.displayIdentity}>
      <form onSubmit={(event) => void save(event)} className="flex flex-col gap-4 px-screen-margin">
        <div className="flex items-center gap-4">
          <Avatar name={displayName} src={avatarUrl} size="large" decorative />
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-label={copy.profilePhoto}
            onChange={(event) => void choosePhoto(event)}
          />
          <Button
            variant="secondary"
            loading={uploading}
            onClick={() => fileInput.current?.click()}
          >
            {avatarUrl === null ? webCopy.choosePhoto : webCopy.changePhoto}
          </Button>
        </div>
        <TextField
          label={copy.displayName}
          value={form.displayName}
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="name"
          onChange={(event) =>
            dispatch({ type: 'edit', field: 'displayName', value: event.target.value })
          }
          error={validation === 'name_required' ? webCopy.somethingWrong : null}
          hint={webCopy.displayNameHint}
        />
        <TextArea
          label={youCopy.bio}
          value={form.bio}
          maxLength={BIO_MAX}
          onChange={(event) => dispatch({ type: 'edit', field: 'bio', value: event.target.value })}
          hint={youCopy.bioHint}
          error={validation === 'bio_too_long' ? webCopy.somethingWrong : form.error}
        />
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={form.saving}
            disabled={!dirty || validation !== null}
          >
            {youCopy.save}
          </Button>
        </div>
      </form>
    </SettingsSection>
  )
}

function HandleRow({ current }: { current: string }) {
  const earth = useEarth()
  const [check, dispatch] = useReducer(handleCheckReducer, current, initialHandleCheck)

  useEffect(() => {
    if (!handleNeedsCheck(check)) return
    const candidate = check.handle
    const timer = setTimeout(() => {
      dispatch({ type: 'checking', handle: candidate })
      earth.identity
        .handleAvailable(candidate)
        .then((available) => dispatch({ type: 'result', handle: candidate, available }))
        .catch(() => dispatch({ type: 'error', handle: candidate }))
    }, HANDLE_CHECK_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [check, earth])

  const trailing =
    check.status === 'checking'
      ? webCopy.handleChecking
      : check.status === 'available'
        ? webCopy.handleAvailable
        : check.status === 'taken'
          ? webCopy.handleTaken
          : check.status === 'same'
            ? youCopy.handleSame
            : check.status === 'invalid'
              ? webCopy.handleInvalid
              : ''

  return (
    <SettingsSection title={items.handle} hint={youCopy.handleChangeSoon}>
      <div className="px-screen-margin">
        <TextField
          label={copy.handle}
          value={check.input}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => dispatch({ type: 'input', value: event.target.value, current })}
          hint={`${formatHandle(current)} · ${webCopy.handleHint}`}
          trailing={trailing}
          error={check.status === 'error' ? webCopy.somethingWrong : null}
        />
      </div>
    </SettingsSection>
  )
}

function messageFor(code: string): string {
  switch (code) {
    case 'rate_limited':
      return webCopy.tooManyTries
    case 'invalid_input':
      return webCopy.checkAddress
    default:
      return webCopy.somethingWrong
  }
}

function AccessCredentials() {
  const { runtime } = useRuntime()
  const session = useSession()
  const toast = useToast()
  const credentials = credentialsFrom(session.session)
  const [flow, dispatch] = useReducer(credentialFlowReducer, 'email', initialCredentialFlow)
  const [open, setOpen] = useState(false)

  const start = (method: CredentialMethod) => {
    dispatch({ type: 'start', method })
    setOpen(true)
  }

  const send = async (event: FormEvent) => {
    event.preventDefault()
    if (runtime === null) return
    dispatch({ type: 'busy' })
    try {
      await startCredentialChange(runtime.supabase.auth, flow.method, flow.destination)
      dispatch({ type: 'sent' })
    } catch (cause) {
      dispatch({ type: 'failed', error: messageFor(errorCode(cause)) })
    }
  }

  const verify = async (event: FormEvent) => {
    event.preventDefault()
    if (runtime === null) return
    dispatch({ type: 'busy' })
    try {
      await verifyCredentialChange(runtime.supabase.auth, flow.method, flow.destination, flow.code)
      await session.refresh()
      dispatch({ type: 'verified' })
      toast.show(youCopy.credentialAdded)
      setOpen(false)
    } catch (cause) {
      const code = errorCode(cause)
      dispatch({
        type: 'failed',
        error: code === 'invalid_input' ? webCopy.codeInvalid : messageFor(code),
      })
    }
  }

  return (
    <SettingsSection title={items.accessCredentials} hint={youCopy.credentials}>
      <List>
        <ListRow
          title={webCopy.email}
          subtitle={credentials.email ?? youCopy.noCredential}
          trailing={
            credentials.email === null ? (
              <Button variant="quiet" onClick={() => start('email')}>
                {youCopy.addEmail}
              </Button>
            ) : undefined
          }
        />
        <ListRow
          title={webCopy.phone}
          subtitle={credentials.phone ?? youCopy.noCredential}
          trailing={
            credentials.phone === null ? (
              <Button variant="quiet" onClick={() => start('phone')}>
                {youCopy.addPhone}
              </Button>
            ) : undefined
          }
        />
      </List>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={flow.method === 'email' ? youCopy.addEmail : youCopy.addPhone}
        closeButton
      >
        {flow.step === 'code' ? (
          <form onSubmit={(event) => void verify(event)} className="flex flex-col gap-3">
            <p className="text-secondary text-text-secondary">
              {youCopy.codeSentTo(flow.destination)}
            </p>
            <TextField
              label={webCopy.codeLabel}
              value={flow.code}
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              onChange={(event) => dispatch({ type: 'code', value: event.target.value })}
              error={flow.error}
            />
            <Button
              type="submit"
              variant="primary"
              fullWidth
              loading={flow.busy}
              disabled={flow.code.trim().length < 4}
            >
              {webCopy.continue}
            </Button>
            <Button variant="quiet" fullWidth onClick={() => dispatch({ type: 'restart' })}>
              {webCopy.sendAgain}
            </Button>
          </form>
        ) : (
          <form onSubmit={(event) => void send(event)} className="flex flex-col gap-3">
            {flow.method === 'email' ? (
              <TextField
                label={webCopy.emailLabel}
                type="email"
                inputMode="email"
                autoComplete="email"
                autoFocus
                value={flow.destination}
                onChange={(event) => dispatch({ type: 'destination', value: event.target.value })}
                error={flow.error}
              />
            ) : (
              <TextField
                label={webCopy.phoneLabel}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                autoFocus
                hint={webCopy.phoneHint}
                value={flow.destination}
                onChange={(event) => dispatch({ type: 'destination', value: event.target.value })}
                error={flow.error}
              />
            )}
            <Button
              type="submit"
              variant="primary"
              fullWidth
              loading={flow.busy}
              disabled={flow.destination.trim() === ''}
            >
              {webCopy.sendCode}
            </Button>
          </form>
        )}
      </Sheet>
    </SettingsSection>
  )
}

function Recovery() {
  const earth = useEarth()
  const session = useSession()
  const analytics = useAnalytics()
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      await earth.claim.createReview({
        kind: IdentityReviewKinds.recovery,
        details: { source: 'settings' },
      })
      analytics.track('account_recovery_started', {
        method: credentialMethod(session.session) ?? 'email',
      })
      setDone(true)
    } catch (cause) {
      setError(errorCode(cause) === 'rate_limited' ? webCopy.tooManyTries : webCopy.somethingWrong)
    } finally {
      setBusy(false)
    }
  }

  return (
    <SettingsSection title={items.recovery} hint={youCopy.recoveryLine}>
      <div className="flex flex-col items-start gap-2 px-screen-margin">
        {done ? (
          <p role="status" className="text-body">
            {youCopy.recoveryRequested}
          </p>
        ) : (
          <Button variant="secondary" loading={busy} onClick={() => void start()}>
            {copy.recoverYourPlace}
          </Button>
        )}
        {error !== null ? (
          <p role="alert" className="text-secondary text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </SettingsSection>
  )
}

function DeleteAccount() {
  const earth = useEarth()
  const session = useSession()
  const router = useRouter()
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await earth.claim.createReview(DELETE_ACCOUNT_REVIEW)
      await session.signOut()
      toast.show(youCopy.deleteRequested)
      router.push(ROUTES.home)
    } catch (cause) {
      setError(errorCode(cause) === 'rate_limited' ? webCopy.tooManyTries : webCopy.somethingWrong)
      setBusy(false)
    }
  }

  return (
    <SettingsSection title={items.deactivateOrDelete}>
      <div className="px-screen-margin">
        <Button variant="destructive" onClick={() => setOpen(true)}>
          {youCopy.deleteTitle}
        </Button>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title={youCopy.deleteTitle}>
        <div className="flex flex-col gap-4">
          <p className="text-body">{youCopy.deleteBody}</p>
          {error !== null ? (
            <p role="alert" className="text-secondary text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            <Button variant="destructive" fullWidth loading={busy} onClick={() => void confirm()}>
              {youCopy.deleteConfirm}
            </Button>
            <Button variant="quiet" fullWidth onClick={() => setOpen(false)}>
              {copy.notNow}
            </Button>
          </div>
        </div>
      </Sheet>
    </SettingsSection>
  )
}
