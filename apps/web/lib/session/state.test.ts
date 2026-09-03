import type { AuthSessionLike } from '@earth/auth'
import { fixtures } from '@earth/api/testing'
import { MeDtoSchema } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { LOADING_SESSION, credentialMethod, deriveSession, isHuman } from './state'

const session = (over: Partial<AuthSessionLike['user']> = {}): AuthSessionLike => ({
  access_token: 'a.b.c',
  user: { id: 'u1', ...over },
})

const me = (over: Parameters<typeof fixtures.meDto>[0] = {}) =>
  MeDtoSchema.parse(fixtures.meDto(over))

describe('deriveSession', () => {
  it('is a Visitor without a credential, whatever me_get says', () => {
    const visitor = deriveSession(null, me({ roleKind: 'visitor', humanId: null, identity: null }))
    expect(visitor.roleKind).toBe('visitor')
    expect(visitor.humanId).toBeNull()
    expect(visitor.status).toBe('ready')
  })

  it('is a Guest for an anonymous credential', () => {
    expect(deriveSession(session({ is_anonymous: true }), null).roleKind).toBe('guest')
  })

  it('is claiming with a real credential until the Human is active', () => {
    expect(deriveSession(session(), null).roleKind).toBe('claiming')
    const pending = me({ roleKind: 'claiming', humanStatus: 'pending', identity: null })
    expect(deriveSession(session(), pending).roleKind).toBe('claiming')
  })

  it('is a Human with an active Human and carries identity and humanId', () => {
    const active = me({ roleKind: 'human', humanStatus: 'active' })
    const derived = deriveSession(session(), active)
    expect(derived.roleKind).toBe('human')
    expect(derived.humanId).toBe(active.humanId)
    expect(derived.identity).toEqual(active.identity)
    expect(isHuman(derived)).toBe(true)
  })

  it('lets the database answer win over the local hint, never as service', () => {
    const restricted = me({ roleKind: 'claiming', humanStatus: 'restricted' })
    expect(deriveSession(session(), restricted).roleKind).toBe('claiming')
    const service = me({ roleKind: 'service', humanStatus: 'active' })
    expect(deriveSession(session(), service).roleKind).toBe('human')
  })

  it('starts as a loading Visitor', () => {
    expect(LOADING_SESSION.status).toBe('loading')
    expect(LOADING_SESSION.roleKind).toBe('visitor')
  })
})

describe('credentialMethod', () => {
  it('reads phone first, then email', () => {
    expect(credentialMethod(null)).toBeNull()
    expect(credentialMethod(session({ email: 'maya@example.com' }))).toBe('email')
    expect(credentialMethod(session({ phone: '+14155550100', email: 'x@y.z' }))).toBe('phone')
    expect(credentialMethod(session())).toBeNull()
  })
})
