/**
 * What the shell knows about the person (ARCHITECTURE §4): the Supabase session plus `me_get()`,
 * reduced to one of the four states with `roleKindFromSession`. Pure so the derivation is tested
 * without a browser.
 */
import { type AuthSessionLike, roleKindFromSession } from '@earth/auth'
import type { HumanId, HumanStatus, MeDto, PublicIdentityDto, RoleKind } from '@earth/domain'

export type SessionStatus = 'loading' | 'ready'

export interface SessionSnapshot {
  readonly status: SessionStatus
  readonly session: AuthSessionLike | null
  readonly me: MeDto | null
  readonly roleKind: RoleKind
  readonly humanId: HumanId | null
  readonly identity: PublicIdentityDto | null
  readonly humanStatus: HumanStatus | null
}

export const LOADING_SESSION: SessionSnapshot = {
  status: 'loading',
  session: null,
  me: null,
  roleKind: 'visitor',
  humanId: null,
  identity: null,
  humanStatus: null,
}

/**
 * Combines the credential with `me_get()`. The role kind is derived client-side from the session
 * and `humanStatus` (a UI hint); when `me_get()` answered, its own `roleKind` wins because the
 * database is the authority — except that a `service` answer can never describe a browser.
 */
export function deriveSession(session: AuthSessionLike | null, me: MeDto | null): SessionSnapshot {
  const humanStatus = me?.humanStatus ?? null
  const derived = roleKindFromSession(session, humanStatus)
  const roleKind: RoleKind =
    me !== null && me.roleKind !== 'service' && session !== null ? me.roleKind : derived
  return {
    status: 'ready',
    session,
    me,
    roleKind,
    humanId: me?.humanId ?? null,
    identity: me?.identity ?? null,
    humanStatus,
  }
}

export function isHuman(snapshot: Pick<SessionSnapshot, 'roleKind'>): boolean {
  return snapshot.roleKind === 'human'
}

/** The credential method behind a session, for `account_recovery_started`. */
export function credentialMethod(session: AuthSessionLike | null): 'email' | 'phone' | null {
  if (session === null) return null
  if (typeof session.user.phone === 'string' && session.user.phone !== '') return 'phone'
  if (typeof session.user.email === 'string' && session.user.email !== '') return 'email'
  return null
}
