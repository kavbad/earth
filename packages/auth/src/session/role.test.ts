import { describe, expect, it } from 'vitest'

import { HUMAN_STATUS } from '@earth/domain'

import { type AuthSessionLike } from './client'
import { isAnonymousSession, readJwtClaims, roleKindFromSession } from './role'

function jwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}.signature`
}

function session(
  overrides: Partial<AuthSessionLike['user']>,
  token = jwt({ sub: 'u1' }),
): AuthSessionLike {
  return { access_token: token, user: { id: 'u1', ...overrides } }
}

describe('readJwtClaims', () => {
  it('decodes the payload without verifying', () => {
    expect(
      readJwtClaims(jwt({ sub: 'u1', is_anonymous: true, role: 'authenticated', exp: 42 })),
    ).toEqual({
      sub: 'u1',
      is_anonymous: true,
      role: 'authenticated',
      exp: 42,
    })
  })

  it('returns null for non-JWT tokens and malformed payloads', () => {
    expect(readJwtClaims('')).toBeNull()
    expect(readJwtClaims('opaque-token')).toBeNull()
    expect(readJwtClaims('a..c')).toBeNull()
    expect(readJwtClaims('a.!!!.c')).toBeNull()
    expect(readJwtClaims(`a.${Buffer.from('[1]').toString('base64url')}.c`)).toBeNull()
  })
})

describe('isAnonymousSession', () => {
  it('prefers the user object, then the JWT claim, then false', () => {
    expect(isAnonymousSession(session({ is_anonymous: true }))).toBe(true)
    expect(isAnonymousSession(session({ is_anonymous: false }, jwt({ is_anonymous: true })))).toBe(
      false,
    )
    expect(isAnonymousSession(session({}, jwt({ is_anonymous: true })))).toBe(true)
    expect(isAnonymousSession(session({}, jwt({ sub: 'u1' })))).toBe(false)
    expect(isAnonymousSession(session({}, 'opaque'))).toBe(false)
  })
})

describe('roleKindFromSession', () => {
  it('is visitor without a session, regardless of any Human status', () => {
    expect(roleKindFromSession(null, null)).toBe('visitor')
    expect(roleKindFromSession(null, 'active')).toBe('visitor')
  })

  it('is guest for an anonymous credential even if a Human status is passed', () => {
    expect(roleKindFromSession(session({ is_anonymous: true }), null)).toBe('guest')
    expect(roleKindFromSession(session({}, jwt({ is_anonymous: true })), 'active')).toBe('guest')
  })

  it('is human only for an active Human and claiming otherwise', () => {
    const real = session({ is_anonymous: false })
    expect(roleKindFromSession(real, 'active')).toBe('human')
    expect(roleKindFromSession(real, null)).toBe('claiming')
    for (const status of HUMAN_STATUS) {
      expect(roleKindFromSession(real, status)).toBe(status === 'active' ? 'human' : 'claiming')
    }
  })
})
