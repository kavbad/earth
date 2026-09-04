/**
 * Adding an email or phone to an existing credential (SCREEN 25 Account → Access credentials):
 * Supabase's `updateUser` sends the code and `verifyOtp` with the `*_change` type confirms it.
 * `@earth/auth` covers sign-in OTPs only, so this small structural wrapper mirrors its error
 * mapping; the auth client is read structurally off the shell's runtime (a fake in tests).
 */
import {
  type AuthErrorLike,
  EmailSchema,
  OtpTokenSchema,
  PhoneSchema,
  authErrorToEarthError,
} from '@earth/auth'
import { EarthError } from '@earth/domain'
import type { z } from 'zod'

import type { CredentialMethod } from './settings'

export type CredentialChangeOtpType = 'email_change' | 'phone_change'

export type CredentialVerifyParams =
  | { readonly email: string; readonly token: string; readonly type: 'email_change' }
  | { readonly phone: string; readonly token: string; readonly type: 'phone_change' }

/** The two `supabase.auth` methods this needs, structurally. */
export interface CredentialAuthLike {
  updateUser(attributes: {
    email?: string
    phone?: string
  }): Promise<{ readonly error: AuthErrorLike | null }>
  verifyOtp(params: CredentialVerifyParams): Promise<{ readonly error: AuthErrorLike | null }>
}

/** Finds `runtime.supabase.auth` when it has what this needs; `null` otherwise. */
export function credentialAuthFrom(runtime: unknown): CredentialAuthLike | null {
  if (runtime === null || typeof runtime !== 'object') return null
  const supabase = (runtime as { supabase?: unknown }).supabase
  if (supabase === null || typeof supabase !== 'object') return null
  const auth = (supabase as { auth?: unknown }).auth
  if (auth === null || typeof auth !== 'object') return null
  const candidate = auth as Partial<CredentialAuthLike>
  if (typeof candidate.updateUser !== 'function' || typeof candidate.verifyOtp !== 'function') {
    return null
  }
  return {
    updateUser: (attributes) => candidate.updateUser!(attributes),
    verifyOtp: (params) => candidate.verifyOtp!(params),
  }
}

function parse<T>(schema: z.ZodType<T, string>, value: string, field: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new EarthError('invalid_input', { details: { field, reason: 'malformed' } })
  }
  return parsed.data
}

/** Sends the verification code to the new address / number. */
export async function startCredentialChange(
  auth: CredentialAuthLike,
  method: CredentialMethod,
  destination: string,
): Promise<string> {
  if (method === 'email') {
    const email = parse(EmailSchema, destination, 'email')
    const { error } = await auth.updateUser({ email })
    if (error !== null) throw authErrorToEarthError(error)
    return email
  }
  const phone = parse(PhoneSchema, destination, 'phone')
  const { error } = await auth.updateUser({ phone })
  if (error !== null) throw authErrorToEarthError(error)
  return phone
}

/** Confirms the code; the session's user then carries the new credential. */
export async function verifyCredentialChange(
  auth: CredentialAuthLike,
  method: CredentialMethod,
  destination: string,
  code: string,
): Promise<void> {
  const token = parse(OtpTokenSchema, code, 'token')
  const params: CredentialVerifyParams =
    method === 'email'
      ? { email: parse(EmailSchema, destination, 'email'), token, type: 'email_change' }
      : { phone: parse(PhoneSchema, destination, 'phone'), token, type: 'phone_change' }
  const { error } = await auth.verifyOtp(params)
  if (error !== null) throw authErrorToEarthError(error)
}
