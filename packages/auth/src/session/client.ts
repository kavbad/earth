/**
 * Session helpers over Supabase Auth (ARCHITECTURE §4: a credential is never a Human).
 *
 * The auth client is typed structurally ({@link MinimalAuthClient}) so both clients pass the
 * real `supabase.auth` and tests pass a fake. Every failure is surfaced as an `EarthError`
 * with a stable code (`rate_limited`, `invalid_input`, `not_authenticated`, `internal`).
 *
 * Credentials offered in V1 (spec §45 step 4): email OTP and phone OTP. Guests (spec §34) are
 * anonymous Supabase users (`is_anonymous` claim) created by {@link SupabaseSession.signInAnonymously}.
 */
import { EarthError, type EarthErrorCode } from '@earth/domain'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Structural auth client
// ---------------------------------------------------------------------------

export interface AuthErrorLike {
  readonly message: string
  readonly code?: string | undefined
  readonly status?: number | undefined
}

export interface AuthUserLike {
  readonly id: string
  readonly is_anonymous?: boolean | undefined
  readonly email?: string | undefined
  readonly phone?: string | undefined
}

export interface AuthSessionLike {
  readonly access_token: string
  /** Unix seconds. */
  readonly expires_at?: number | undefined
  readonly user: AuthUserLike
}

export interface AuthResultLike<T> {
  readonly data: T
  readonly error: AuthErrorLike | null
}

export type AuthSessionData = { readonly session: AuthSessionLike | null }
export type AuthUserSessionData = {
  readonly session: AuthSessionLike | null
  readonly user: AuthUserLike | null
}

export interface EmailOtpCredentials {
  readonly email: string
  readonly options?: { readonly emailRedirectTo?: string; readonly shouldCreateUser?: boolean }
}

export interface PhoneOtpCredentials {
  readonly phone: string
  readonly options?: { readonly shouldCreateUser?: boolean; readonly channel?: 'sms' | 'whatsapp' }
}

/** The two OTP channels used by Earth; the values are Supabase's `type` parameter. */
export const OTP_TYPES = { email: 'email', phone: 'sms' } as const
export type OtpType = (typeof OTP_TYPES)[keyof typeof OTP_TYPES]

export type VerifyOtpParamsLike =
  | { readonly email: string; readonly token: string; readonly type: typeof OTP_TYPES.email }
  | { readonly phone: string; readonly token: string; readonly type: typeof OTP_TYPES.phone }

export interface AuthSubscriptionLike {
  unsubscribe(): void
}

/** The subset of `SupabaseClient['auth']` this package uses. */
export interface MinimalAuthClient {
  getSession(): Promise<AuthResultLike<AuthSessionData>>
  onAuthStateChange(callback: (event: string, session: AuthSessionLike | null) => void): {
    readonly data: { readonly subscription: AuthSubscriptionLike }
  }
  signInWithOtp(
    credentials: EmailOtpCredentials | PhoneOtpCredentials,
  ): Promise<AuthResultLike<unknown>>
  verifyOtp(params: VerifyOtpParamsLike): Promise<AuthResultLike<AuthUserSessionData>>
  signInAnonymously(): Promise<AuthResultLike<AuthUserSessionData>>
  signOut(): Promise<{ readonly error: AuthErrorLike | null }>
}

export interface SupabaseLike {
  readonly auth: MinimalAuthClient
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const EmailSchema = z.string().trim().toLowerCase().pipe(z.email())
/** E.164 (`+14155552671`), spaces and dashes tolerated on input. */
export const PhoneSchema = z
  .string()
  .transform((value) => value.replace(/[\s\-().]/g, ''))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/))
export const OtpTokenSchema = z
  .string()
  .transform((value) => value.replace(/\s/g, ''))
  .pipe(z.string().regex(/^\d{4,10}$/))

export type VerifyOtpInput =
  | { readonly email: string; readonly token: string }
  | { readonly phone: string; readonly token: string }

export type SessionChangeListener = (session: AuthSessionLike | null, event: string) => void

export interface SupabaseSession {
  /** The current session, `null` for a visitor. */
  getSession(): Promise<AuthSessionLike | null>
  /** Bearer token for the server tier and RPC calls; `null` for a visitor. */
  getAccessToken(): Promise<string | null>
  /** Subscribes to sign-in/out and refresh; returns the unsubscribe function. */
  onChange(listener: SessionChangeListener): () => void
  signInWithEmailOtp(email: string, options?: { readonly emailRedirectTo?: string }): Promise<void>
  signInWithPhoneOtp(phone: string): Promise<void>
  /** Exchanges the code for a session. */
  verifyOtp(input: VerifyOtpInput): Promise<AuthSessionLike>
  /** Creates a Guest credential (anonymous Supabase user). */
  signInAnonymously(): Promise<AuthSessionLike>
  signOut(): Promise<void>
}

export interface CreateSupabaseSessionOptions {
  readonly supabase: SupabaseLike
}

export function createSupabaseSession({ supabase }: CreateSupabaseSessionOptions): SupabaseSession {
  const auth = supabase.auth

  const getSession = async (): Promise<AuthSessionLike | null> => {
    const { data, error } = await auth.getSession()
    if (error !== null) throw authErrorToEarthError(error)
    return data.session
  }

  const requireSession = (
    data: AuthUserSessionData,
    error: AuthErrorLike | null,
  ): AuthSessionLike => {
    if (error !== null) throw authErrorToEarthError(error)
    if (data.session === null) {
      throw new EarthError('not_authenticated', {
        details: { reason: 'no_session' },
        message: 'auth: the credential exchange returned no session',
      })
    }
    return data.session
  }

  return {
    getSession,
    getAccessToken: async () => (await getSession())?.access_token ?? null,
    onChange: (listener) => {
      const { data } = auth.onAuthStateChange((event, session) => {
        listener(session, event)
      })
      return () => data.subscription.unsubscribe()
    },
    signInWithEmailOtp: async (email, options) => {
      const parsedEmail = parseInput(EmailSchema, email, 'email')
      const { error } = await auth.signInWithOtp({
        email: parsedEmail,
        options: { shouldCreateUser: true, ...options },
      })
      if (error !== null) throw authErrorToEarthError(error)
    },
    signInWithPhoneOtp: async (phone) => {
      const parsedPhone = parseInput(PhoneSchema, phone, 'phone')
      const { error } = await auth.signInWithOtp({
        phone: parsedPhone,
        options: { shouldCreateUser: true },
      })
      if (error !== null) throw authErrorToEarthError(error)
    },
    verifyOtp: async (input) => {
      const token = parseInput(OtpTokenSchema, input.token, 'token')
      const params: VerifyOtpParamsLike =
        'email' in input
          ? { email: parseInput(EmailSchema, input.email, 'email'), token, type: OTP_TYPES.email }
          : { phone: parseInput(PhoneSchema, input.phone, 'phone'), token, type: OTP_TYPES.phone }
      const { data, error } = await auth.verifyOtp(params)
      return requireSession(data, error)
    },
    signInAnonymously: async () => {
      const { data, error } = await auth.signInAnonymously()
      return requireSession(data, error)
    },
    signOut: async () => {
      const { error } = await auth.signOut()
      if (error !== null) throw authErrorToEarthError(error)
    },
  }
}

function parseInput<T>(schema: z.ZodType<T, string>, value: string, field: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new EarthError('invalid_input', {
      details: { field, reason: 'malformed' },
      message: `auth: ${field} is malformed`,
    })
  }
  return parsed.data
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** Supabase Auth error codes that mean "the code you typed is wrong or stale". */
const INVALID_INPUT_AUTH_CODES: ReadonlySet<string> = new Set([
  'otp_expired',
  'otp_disabled',
  'validation_failed',
  'bad_code_verifier',
  'invalid_credentials',
  'email_address_invalid',
  'phone_not_confirmed',
])

/** Maps a Supabase Auth error onto a stable Earth code. */
export function authErrorCode(error: AuthErrorLike): EarthErrorCode {
  const code = error.code ?? ''
  if (error.status === 429 || code.includes('rate_limit')) return 'rate_limited'
  if (INVALID_INPUT_AUTH_CODES.has(code)) return 'invalid_input'
  if (error.status === 400 || error.status === 422) return 'invalid_input'
  if (error.status === 401 || error.status === 403) return 'not_authenticated'
  return 'internal'
}

export function authErrorToEarthError(error: AuthErrorLike): EarthError {
  return new EarthError(authErrorCode(error), {
    cause: error,
    message: error.message,
    details: {
      ...(error.code === undefined ? {} : { authCode: error.code }),
      ...(error.status === undefined ? {} : { httpStatus: error.status }),
    },
  })
}
