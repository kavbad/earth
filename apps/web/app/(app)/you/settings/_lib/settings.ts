/**
 * Pure state of SCREEN 25 (Account): the display identity form, the handle availability
 * machine (stale answers never win), the add-a-credential flow, the Human Pass labels and the
 * delete request. Reducers so the screens stay thin and the rules are unit-tested.
 */
import { type AuthSessionLike } from '@earth/auth'
import {
  BIO_MAX,
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_MIN,
  isValidHandle,
  normalizeHandle,
} from '@earth/domain'

// ---------------------------------------------------------------------------
// Display identity
// ---------------------------------------------------------------------------

export interface IdentityForm {
  readonly displayName: string
  readonly bio: string
  readonly saving: boolean
  readonly error: string | null
  readonly savedAt: number | null
}

export type IdentityFormAction =
  | { readonly type: 'edit'; readonly field: 'displayName' | 'bio'; readonly value: string }
  | { readonly type: 'reset'; readonly displayName: string; readonly bio: string | null }
  | { readonly type: 'saving' }
  | { readonly type: 'saved'; readonly at: number }
  | { readonly type: 'failed'; readonly error: string }

export function initialIdentityForm(displayName: string, bio: string | null): IdentityForm {
  return { displayName, bio: bio ?? '', saving: false, error: null, savedAt: null }
}

export function identityFormReducer(state: IdentityForm, action: IdentityFormAction): IdentityForm {
  switch (action.type) {
    case 'edit':
      return { ...state, [action.field]: action.value, error: null, savedAt: null }
    case 'reset':
      return initialIdentityForm(action.displayName, action.bio)
    case 'saving':
      return { ...state, saving: true, error: null }
    case 'saved':
      return { ...state, saving: false, savedAt: action.at }
    case 'failed':
      return { ...state, saving: false, error: action.error }
    default: {
      const exhaustive: never = action
      throw new Error(`Unknown identity form action: ${String(exhaustive)}`)
    }
  }
}

export type IdentityFormError = 'name_required' | 'name_too_long' | 'bio_too_long'

export function identityFormError(
  form: Pick<IdentityForm, 'displayName' | 'bio'>,
): IdentityFormError | null {
  const name = form.displayName.trim()
  if (name.length < DISPLAY_NAME_MIN) return 'name_required'
  if (name.length > DISPLAY_NAME_MAX) return 'name_too_long'
  if (form.bio.length > BIO_MAX) return 'bio_too_long'
  return null
}

export interface IdentityCurrent {
  readonly displayName: string
  readonly bio: string | null
}

/** Only what changed goes to `identity_update` (omitted fields stay untouched). */
export function identityUpdatePayload(
  form: Pick<IdentityForm, 'displayName' | 'bio'>,
  current: IdentityCurrent,
): { displayName?: string; bio?: string } {
  const out: { displayName?: string; bio?: string } = {}
  const name = form.displayName.trim()
  if (name !== current.displayName) out.displayName = name
  const bio = form.bio.trim()
  if (bio !== (current.bio ?? '')) out.bio = bio
  return out
}

// ---------------------------------------------------------------------------
// Handle availability
// ---------------------------------------------------------------------------

export type HandleCheckStatus =
  'idle' | 'same' | 'invalid' | 'checking' | 'available' | 'taken' | 'error'

export interface HandleCheck {
  readonly input: string
  /** Normalized candidate (lowercase, no `@`). */
  readonly handle: string
  readonly status: HandleCheckStatus
}

export type HandleCheckAction =
  | { readonly type: 'input'; readonly value: string; readonly current: string }
  | { readonly type: 'checking'; readonly handle: string }
  | { readonly type: 'result'; readonly handle: string; readonly available: boolean }
  | { readonly type: 'error'; readonly handle: string }

export function initialHandleCheck(current: string): HandleCheck {
  return { input: current, handle: current, status: 'same' }
}

export function handleCheckReducer(state: HandleCheck, action: HandleCheckAction): HandleCheck {
  switch (action.type) {
    case 'input': {
      const handle = normalizeHandle(action.value)
      if (handle === action.current) return { input: action.value, handle, status: 'same' }
      if (!isValidHandle(handle)) return { input: action.value, handle, status: 'invalid' }
      return { input: action.value, handle, status: 'idle' }
    }
    case 'checking':
      return action.handle === state.handle ? { ...state, status: 'checking' } : state
    case 'result':
      // A slower answer for an older candidate must not overwrite the current one.
      if (action.handle !== state.handle) return state
      return { ...state, status: action.available ? 'available' : 'taken' }
    case 'error':
      return action.handle === state.handle ? { ...state, status: 'error' } : state
    default: {
      const exhaustive: never = action
      throw new Error(`Unknown handle check action: ${String(exhaustive)}`)
    }
  }
}

/** Whether a round trip is due for the current candidate. */
export function handleNeedsCheck(state: HandleCheck): boolean {
  return state.status === 'idle'
}

// ---------------------------------------------------------------------------
// Access credentials
// ---------------------------------------------------------------------------

export const CREDENTIAL_METHODS = ['email', 'phone'] as const
export type CredentialMethod = (typeof CREDENTIAL_METHODS)[number]

export interface Credentials {
  readonly email: string | null
  readonly phone: string | null
}

export function credentialsFrom(session: AuthSessionLike | null): Credentials {
  const email = session?.user.email
  const phone = session?.user.phone
  return {
    email: typeof email === 'string' && email !== '' ? email : null,
    phone: typeof phone === 'string' && phone !== '' ? phone : null,
  }
}

export type CredentialStep = 'enter' | 'code' | 'done'

export interface CredentialFlow {
  readonly method: CredentialMethod
  readonly step: CredentialStep
  readonly destination: string
  readonly code: string
  readonly busy: boolean
  readonly error: string | null
}

export type CredentialAction =
  | { readonly type: 'start'; readonly method: CredentialMethod }
  | { readonly type: 'destination'; readonly value: string }
  | { readonly type: 'code'; readonly value: string }
  | { readonly type: 'busy' }
  | { readonly type: 'sent' }
  | { readonly type: 'verified' }
  | { readonly type: 'failed'; readonly error: string }
  | { readonly type: 'restart' }

export function initialCredentialFlow(method: CredentialMethod = 'email'): CredentialFlow {
  return { method, step: 'enter', destination: '', code: '', busy: false, error: null }
}

export function credentialFlowReducer(
  state: CredentialFlow,
  action: CredentialAction,
): CredentialFlow {
  switch (action.type) {
    case 'start':
      return initialCredentialFlow(action.method)
    case 'destination':
      return { ...state, destination: action.value, error: null }
    case 'code':
      return { ...state, code: action.value, error: null }
    case 'busy':
      return { ...state, busy: true, error: null }
    case 'sent':
      return { ...state, busy: false, step: 'code', code: '' }
    case 'verified':
      return { ...state, busy: false, step: 'done', code: '' }
    case 'failed':
      return { ...state, busy: false, error: action.error }
    case 'restart':
      return { ...initialCredentialFlow(state.method), destination: state.destination }
    default: {
      const exhaustive: never = action
      throw new Error(`Unknown credential action: ${String(exhaustive)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Delete request (no `human_delete` RPC in V1: a `help` review carries the request)
// ---------------------------------------------------------------------------

export const DELETE_ACCOUNT_REVIEW = { kind: 'help', details: { action: 'delete' } } as const
