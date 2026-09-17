'use client'

/**
 * Spec §45 step 5: public identity — display name required, handle auto-suggested and editable,
 * profile photo optional. Nothing here is Human Pass data (spec §17, §78).
 */
import { copy } from '@earth/ui'
import {
  DISPLAY_NAME_MAX,
  HANDLE_MAX_LENGTH,
  handleCandidates,
  isValidHandle,
  normalizeHandle,
} from '@earth/domain'
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react'

import { Avatar } from '../../../components/ui/Avatar'
import { Button } from '../../../components/ui/Button'
import { TextField } from '../../../components/ui/TextField'
import { webCopy } from '../../../lib/copy'
import { errorCode } from '../../../lib/errors'
import { useEarth } from '../../../lib/providers/RuntimeProvider'
import { useClaimFlow } from '../_components/ClaimFlowProvider'
import { ClaimTitle } from '../_components/ClaimFrame'

type CheckStatus = 'idle' | 'checking' | 'available' | 'taken'

interface Photo {
  readonly file: File
  readonly url: string
}

const SUGGESTION_ATTEMPTS = 5
const CHECK_DEBOUNCE_MS = 300

export default function ClaimIdentityPage() {
  const { dispatch } = useClaimFlow()
  const earth = useEarth()
  const [displayName, setDisplayName] = useState('')
  /** What the person typed into the handle field; `null` until they edit the suggestion. */
  const [typed, setTyped] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState('')
  const [check, setCheck] = useState<{ readonly handle: string; readonly status: CheckStatus }>({
    handle: '',
    status: 'idle',
  })
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const ticket = useRef(0)

  const name = displayName.trim()
  const handle = typed ?? (name === '' ? '' : suggestion)
  const normalized = normalizeHandle(handle)
  const syntaxError = normalized !== '' && !isValidHandle(normalized)
  const status: CheckStatus =
    normalized === '' || syntaxError || check.handle !== normalized ? 'idle' : check.status

  // Suggest a handle from the display name until the person edits it (spec §45 step 5).
  useEffect(() => {
    if (typed !== null || name === '') return
    const mine = ++ticket.current
    const timer = setTimeout(async () => {
      for (const candidate of handleCandidates(name, SUGGESTION_ATTEMPTS)) {
        if (mine !== ticket.current) return
        setSuggestion(candidate)
        setCheck({ handle: candidate, status: 'checking' })
        const free = await earth.identity.handleAvailable(candidate).catch(() => false)
        if (mine !== ticket.current) return
        if (free) {
          setCheck({ handle: candidate, status: 'available' })
          return
        }
        setCheck({ handle: candidate, status: 'taken' })
      }
    }, CHECK_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [name, typed, earth])

  // Check an edited handle.
  useEffect(() => {
    if (typed === null) return
    const candidate = normalizeHandle(typed)
    if (candidate === '' || !isValidHandle(candidate)) return
    const mine = ++ticket.current
    const timer = setTimeout(async () => {
      setCheck({ handle: candidate, status: 'checking' })
      const free = await earth.identity.handleAvailable(candidate).catch(() => false)
      if (mine === ticket.current)
        setCheck({ handle: candidate, status: free ? 'available' : 'taken' })
    }, CHECK_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [typed, earth])

  // Release the preview URL when the page goes away.
  const photoUrl = photo?.url ?? null
  useEffect(() => () => (photoUrl === null ? undefined : URL.revokeObjectURL(photoUrl)), [photoUrl])

  const onPhoto = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null
    setPhoto(file === null ? null : { file, url: URL.createObjectURL(file) })
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (name === '' || !isValidHandle(normalized)) return
    setBusy(true)
    setError(null)
    try {
      let avatarMediaId: string | null = null
      if (photo !== null) {
        const uploaded = await earth.identity.uploadAvatar({
          body: photo.file,
          contentType: photo.file.type,
          byteSize: photo.file.size,
        })
        avatarMediaId = uploaded.id
      }
      await earth.claim.setIdentity({ displayName: name, handle: normalized, avatarMediaId })
      dispatch({ type: 'identitySet' })
    } catch (cause) {
      const code = errorCode(cause)
      if (code === 'handle_taken') {
        setTyped(handle)
        setCheck({ handle: normalized, status: 'taken' })
      } else if (code === 'handle_invalid') {
        setTyped(handle)
        setError(webCopy.handleInvalid)
      } else {
        setError(webCopy.somethingWrong)
      }
    } finally {
      setBusy(false)
    }
  }

  const handleTrailing =
    status === 'checking'
      ? webCopy.handleChecking
      : status === 'available'
        ? webCopy.handleAvailable
        : undefined
  const handleError = syntaxError
    ? webCopy.handleInvalid
    : status === 'taken'
      ? webCopy.handleTaken
      : null
  const canSubmit = name !== '' && status === 'available' && !busy

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
      <ClaimTitle>{copy.displayName}</ClaimTitle>
      <TextField
        label={copy.displayName}
        hint={webCopy.displayNameHint}
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        maxLength={DISPLAY_NAME_MAX}
        autoComplete="name"
        autoFocus
        required
      />
      <TextField
        label={copy.handle}
        hint={webCopy.handleHint}
        value={handle}
        onChange={(event) => setTyped(event.target.value)}
        maxLength={HANDLE_MAX_LENGTH + 1}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        trailing={handleTrailing}
        error={handleError}
      />
      <div className="flex items-center gap-4">
        <Avatar name={name === '' ? copy.human : name} src={photoUrl} size="large" decorative />
        <div className="flex flex-col gap-1">
          <span className="text-secondary text-text-secondary">
            {copy.profilePhoto} · {webCopy.photoOptional}
          </span>
          <div className="flex gap-2">
            <Button variant="secondary" onClick={() => fileInput.current?.click()}>
              {photo === null ? webCopy.choosePhoto : webCopy.changePhoto}
            </Button>
            {photo !== null ? (
              <Button variant="quiet" onClick={() => setPhoto(null)}>
                {webCopy.removePhoto}
              </Button>
            ) : null}
          </div>
          <input
            ref={fileInput}
            type="file"
            accept="image/*"
            onChange={onPhoto}
            className="sr-only"
            aria-label={copy.profilePhoto}
            tabIndex={-1}
          />
        </div>
      </div>
      {error !== null ? (
        <p role="alert" className="text-secondary text-danger">
          {error}
        </p>
      ) : null}
      <Button type="submit" variant="primary" fullWidth loading={busy} disabled={!canSubmit}>
        {webCopy.continue}
      </Button>
    </form>
  )
}
