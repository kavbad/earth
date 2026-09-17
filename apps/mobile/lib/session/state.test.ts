import type { AuthSessionLike } from '@earth/auth'
import type { MeDto } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { LOADING_SESSION, credentialMethod, deriveSession, isHuman } from './state'

const HUMAN_ID = '11111111-1111-4111-8111-111111111111'

function session(overrides: Partial<AuthSessionLike['user']> = {}): AuthSessionLike {
  return { access_token: 'x.y.z', user: { id: 'u1', is_anonymous: false, ...overrides } }
}

function me(overrides: Partial<MeDto> = {}): MeDto {
  return {
    roleKind: 'human',
    humanId: HUMAN_ID as MeDto['humanId'],
    identity: null,
    humanStatus: 'active',
    humanPassStatus: 'verified',
    context: null,
    flags: {},
    ...overrides,
  }
}

describe('deriveSession', () => {
  it('is a Visitor without a credential', () => {
    const snapshot = deriveSession(null, null)
    expect(snapshot.status).toBe('ready')
    expect(snapshot.roleKind).toBe('visitor')
    expect(snapshot.humanId).toBeNull()
  })

  it('is a Guest for an anonymous credential', () => {
    expect(deriveSession(session({ is_anonymous: true }), null).roleKind).toBe('guest')
  })

  it('is claiming with a credential but no active Human', () => {
    expect(deriveSession(session(), null).roleKind).toBe('claiming')
  })

  it('lets me_get decide once it answered', () => {
    const snapshot = deriveSession(session(), me())
    expect(snapshot.roleKind).toBe('human')
    expect(snapshot.humanId).toBe(HUMAN_ID)
    expect(isHuman(snapshot)).toBe(true)
  })

  it('never believes a service answer or a Human without a credential', () => {
    expect(deriveSession(session(), me({ roleKind: 'service' })).roleKind).toBe('human')
    expect(deriveSession(null, me()).roleKind).toBe('visitor')
  })

  it('starts loading as a Visitor', () => {
    expect(LOADING_SESSION.status).toBe('loading')
    expect(LOADING_SESSION.roleKind).toBe('visitor')
  })
})

describe('credentialMethod', () => {
  it('reads phone before email and null for Visitors', () => {
    expect(credentialMethod(null)).toBeNull()
    expect(credentialMethod(session({ email: 'a@b.c' }))).toBe('email')
    expect(credentialMethod(session({ email: 'a@b.c', phone: '+1415' }))).toBe('phone')
    expect(credentialMethod(session())).toBeNull()
  })
})
