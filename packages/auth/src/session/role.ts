/**
 * Which of the four states (ARCHITECTURE §4) a session is in, mirrored from
 * `earth.current_role_kind()`: no credential → `visitor`; an anonymous credential (`is_anonymous`
 * JWT claim) → `guest`; a real credential with an active Human → `human`; a real credential
 * without an active Human → `claiming`.
 *
 * The client only reflects this; the database enforces it. `restricted`, `suspended` and
 * `deleted` Humans get no member capabilities and therefore read as `claiming` here — the UI
 * consults `humanStatus` itself to explain why.
 */
import { type HumanStatus, type RoleKind } from '@earth/domain'

import { type AuthSessionLike } from './client'

/** The JWT claims this package reads. Decoding is unverified: it is a UI hint, never authority. */
export interface JwtClaimsLike {
  readonly sub?: string | undefined
  readonly is_anonymous?: boolean | undefined
  readonly role?: string | undefined
  readonly exp?: number | undefined
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  if (typeof atob === 'function') {
    const binary = atob(padded)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }
  return Buffer.from(padded, 'base64').toString('utf8')
}

/** Reads the payload of a JWT without verifying it; `null` when the token is not a JWT. */
export function readJwtClaims(accessToken: string): JwtClaimsLike | null {
  const parts = accessToken.split('.')
  const payload = parts[1]
  if (parts.length !== 3 || payload === undefined || payload === '') return null
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(payload))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    return {
      sub: typeof record['sub'] === 'string' ? record['sub'] : undefined,
      is_anonymous:
        typeof record['is_anonymous'] === 'boolean' ? record['is_anonymous'] : undefined,
      role: typeof record['role'] === 'string' ? record['role'] : undefined,
      exp: typeof record['exp'] === 'number' ? record['exp'] : undefined,
    }
  } catch {
    return null
  }
}

/** True for a Guest credential: the user object or the JWT carries `is_anonymous = true`. */
export function isAnonymousSession(session: AuthSessionLike): boolean {
  if (typeof session.user.is_anonymous === 'boolean') return session.user.is_anonymous
  return readJwtClaims(session.access_token)?.is_anonymous ?? false
}

export function roleKindFromSession(
  session: AuthSessionLike | null,
  humanStatus: HumanStatus | null,
): RoleKind {
  if (session === null) return 'visitor'
  if (isAnonymousSession(session)) return 'guest'
  return humanStatus === 'active' ? 'human' : 'claiming'
}
