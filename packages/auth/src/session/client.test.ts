import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'

import { isEarthError } from '@earth/domain'

import {
  type AuthErrorLike,
  type AuthSessionLike,
  type EmailOtpCredentials,
  type MinimalAuthClient,
  type PhoneOtpCredentials,
  type VerifyOtpParamsLike,
  authErrorCode,
  authErrorToEarthError,
  createSupabaseSession,
} from './client'

// The real supabase-js auth client must satisfy the structural interface (compile-time only).
type RealAuth = SupabaseClient['auth']
const _realAuthFits: MinimalAuthClient = null as unknown as RealAuth
void _realAuthFits

const SESSION: AuthSessionLike = {
  access_token: 'token-1',
  expires_at: 1_800_000_000,
  user: { id: 'user-1', is_anonymous: false, email: 'kavon@example.com' },
}

interface FakeAuthState {
  session: AuthSessionLike | null
  otpCalls: (EmailOtpCredentials | PhoneOtpCredentials)[]
  verifyCalls: VerifyOtpParamsLike[]
  anonymousCalls: number
  signOutCalls: number
  listeners: ((event: string, session: AuthSessionLike | null) => void)[]
  unsubscribed: number
  nextError: AuthErrorLike | null
}

function fakeAuth(session: AuthSessionLike | null = SESSION): {
  auth: MinimalAuthClient
  state: FakeAuthState
} {
  const state: FakeAuthState = {
    session,
    otpCalls: [],
    verifyCalls: [],
    anonymousCalls: 0,
    signOutCalls: 0,
    listeners: [],
    unsubscribed: 0,
    nextError: null,
  }
  const takeError = (): AuthErrorLike | null => {
    const error = state.nextError
    state.nextError = null
    return error
  }
  const auth: MinimalAuthClient = {
    getSession: async () => {
      const error = takeError()
      return { data: { session: error === null ? state.session : null }, error }
    },
    onAuthStateChange: (callback) => {
      state.listeners.push(callback)
      return {
        data: {
          subscription: {
            unsubscribe: () => {
              state.unsubscribed += 1
            },
          },
        },
      }
    },
    signInWithOtp: async (credentials) => {
      state.otpCalls.push(credentials)
      return { data: { user: null, session: null }, error: takeError() }
    },
    verifyOtp: async (params) => {
      state.verifyCalls.push(params)
      const error = takeError()
      return {
        data:
          error === null ? { session: SESSION, user: SESSION.user } : { session: null, user: null },
        error,
      }
    },
    signInAnonymously: async () => {
      state.anonymousCalls += 1
      const error = takeError()
      const guest: AuthSessionLike = {
        access_token: 'guest-token',
        user: { id: 'anon-1', is_anonymous: true },
      }
      return {
        data: error === null ? { session: guest, user: guest.user } : { session: null, user: null },
        error,
      }
    },
    signOut: async () => {
      state.signOutCalls += 1
      return { error: takeError() }
    },
  }
  return { auth, state }
}

const withCode = (code: string) => (error: unknown) => isEarthError(error) && error.code === code

describe('createSupabaseSession', () => {
  it('reads the session and access token, null for visitors', async () => {
    const signedIn = fakeAuth()
    const session = createSupabaseSession({ supabase: { auth: signedIn.auth } })
    expect(await session.getSession()).toEqual(SESSION)
    expect(await session.getAccessToken()).toBe('token-1')

    const visitor = createSupabaseSession({ supabase: { auth: fakeAuth(null).auth } })
    expect(await visitor.getSession()).toBeNull()
    expect(await visitor.getAccessToken()).toBeNull()
  })

  it('forwards auth state changes and unsubscribes', () => {
    const { auth, state } = fakeAuth()
    const session = createSupabaseSession({ supabase: { auth } })
    const seen: [AuthSessionLike | null, string][] = []
    const unsubscribe = session.onChange((s, event) => seen.push([s, event]))

    state.listeners[0]?.('SIGNED_IN', SESSION)
    state.listeners[0]?.('SIGNED_OUT', null)
    expect(seen).toEqual([
      [SESSION, 'SIGNED_IN'],
      [null, 'SIGNED_OUT'],
    ])

    unsubscribe()
    expect(state.unsubscribed).toBe(1)
  })

  it('sends an email OTP with a normalized address', async () => {
    const { auth, state } = fakeAuth()
    const session = createSupabaseSession({ supabase: { auth } })
    await session.signInWithEmailOtp('  Kavon@Example.com ', {
      emailRedirectTo: 'https://earth.social/claim',
    })
    expect(state.otpCalls).toEqual([
      {
        email: 'kavon@example.com',
        options: { shouldCreateUser: true, emailRedirectTo: 'https://earth.social/claim' },
      },
    ])
    await expect(session.signInWithEmailOtp('not-an-email')).rejects.toSatisfy(
      withCode('invalid_input'),
    )
    expect(state.otpCalls).toHaveLength(1)
  })

  it('sends a phone OTP in E.164 and rejects malformed numbers', async () => {
    const { auth, state } = fakeAuth()
    const session = createSupabaseSession({ supabase: { auth } })
    await session.signInWithPhoneOtp('+1 (415) 555-2671')
    expect(state.otpCalls).toEqual([{ phone: '+14155552671', options: { shouldCreateUser: true } }])
    await expect(session.signInWithPhoneOtp('415-555-2671')).rejects.toSatisfy(
      withCode('invalid_input'),
    )
    await expect(session.signInWithPhoneOtp('+0')).rejects.toSatisfy(withCode('invalid_input'))
  })

  it('verifies email and phone codes with the matching Supabase type', async () => {
    const { auth, state } = fakeAuth()
    const session = createSupabaseSession({ supabase: { auth } })
    expect(await session.verifyOtp({ email: 'Kavon@example.com', token: '123 456' })).toEqual(
      SESSION,
    )
    expect(await session.verifyOtp({ phone: '+14155552671', token: '654321' })).toEqual(SESSION)
    expect(state.verifyCalls).toEqual([
      { email: 'kavon@example.com', token: '123456', type: 'email' },
      { phone: '+14155552671', token: '654321', type: 'sms' },
    ])
    await expect(session.verifyOtp({ email: 'kavon@example.com', token: 'abc' })).rejects.toSatisfy(
      withCode('invalid_input'),
    )
  })

  it('maps Supabase auth errors to stable codes', async () => {
    const { auth, state } = fakeAuth()
    const session = createSupabaseSession({ supabase: { auth } })

    state.nextError = { message: 'slow down', status: 429, code: 'over_email_send_rate_limit' }
    await expect(session.signInWithEmailOtp('a@b.co')).rejects.toSatisfy(withCode('rate_limited'))

    state.nextError = { message: 'expired', status: 403, code: 'otp_expired' }
    await expect(session.verifyOtp({ email: 'a@b.co', token: '111111' })).rejects.toSatisfy(
      withCode('invalid_input'),
    )

    state.nextError = { message: 'nope', status: 401 }
    await expect(session.getSession()).rejects.toSatisfy(withCode('not_authenticated'))

    state.nextError = { message: 'down', status: 500 }
    await expect(session.signOut()).rejects.toSatisfy(withCode('internal'))
    expect(state.signOutCalls).toBe(1)
  })

  it('creates a Guest credential and signs out', async () => {
    const { auth, state } = fakeAuth()
    const session = createSupabaseSession({ supabase: { auth } })
    const guest = await session.signInAnonymously()
    expect(guest.user.is_anonymous).toBe(true)
    expect(state.anonymousCalls).toBe(1)

    await session.signOut()
    expect(state.signOutCalls).toBe(1)
  })

  it('treats a credential exchange without a session as not_authenticated', async () => {
    const auth = fakeAuth().auth
    const noSession: MinimalAuthClient = {
      ...auth,
      verifyOtp: async () => ({ data: { session: null, user: null }, error: null }),
      signInAnonymously: async () => ({ data: { session: null, user: null }, error: null }),
    }
    const session = createSupabaseSession({ supabase: { auth: noSession } })
    await expect(session.verifyOtp({ email: 'a@b.co', token: '111111' })).rejects.toSatisfy(
      withCode('not_authenticated'),
    )
    await expect(session.signInAnonymously()).rejects.toSatisfy(withCode('not_authenticated'))
  })
})

describe('authErrorCode', () => {
  it.each([
    [{ message: 'x', status: 429 }, 'rate_limited'],
    [{ message: 'x', code: 'over_sms_send_rate_limit' }, 'rate_limited'],
    [{ message: 'x', code: 'otp_expired', status: 403 }, 'invalid_input'],
    [{ message: 'x', code: 'validation_failed', status: 400 }, 'invalid_input'],
    [{ message: 'x', status: 422 }, 'invalid_input'],
    [{ message: 'x', status: 401 }, 'not_authenticated'],
    [{ message: 'x', status: 403 }, 'not_authenticated'],
    [{ message: 'x', status: 500 }, 'internal'],
    [{ message: 'x' }, 'internal'],
  ] as const)('%o → %s', (error, code) => {
    expect(authErrorCode(error)).toBe(code)
    const mapped = authErrorToEarthError(error)
    expect(mapped.code).toBe(code)
    expect(mapped.message).toBe('x')
    expect(mapped.cause).toBe(error)
  })
})
