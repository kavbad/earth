import { EarthError } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  type CredentialAuthLike,
  credentialAuthFrom,
  startCredentialChange,
  verifyCredentialChange,
} from './credentials'

function fakeAuth(error: { message: string; status?: number } | null = null) {
  const calls: unknown[] = []
  const auth: CredentialAuthLike = {
    async updateUser(attributes) {
      calls.push({ updateUser: attributes })
      return { error }
    },
    async verifyOtp(params) {
      calls.push({ verifyOtp: params })
      return { error }
    },
  }
  return { auth, calls }
}

describe('credential changes (SCREEN 25 Account)', () => {
  it('finds the auth client structurally off a runtime and nothing off anything else', () => {
    const { auth } = fakeAuth()
    expect(credentialAuthFrom({ supabase: { auth } })).not.toBeNull()
    expect(credentialAuthFrom({ supabase: { auth: {} } })).toBeNull()
    expect(credentialAuthFrom({ supabase: null })).toBeNull()
    expect(credentialAuthFrom(null)).toBeNull()
    expect(credentialAuthFrom('runtime')).toBeNull()
  })

  it('normalizes the address, sends the code and verifies with the change type', async () => {
    const { auth, calls } = fakeAuth()
    await expect(startCredentialChange(auth, 'email', ' Maya@Example.com ')).resolves.toBe(
      'maya@example.com',
    )
    await verifyCredentialChange(auth, 'email', 'maya@example.com', '123456')
    expect(calls).toEqual([
      { updateUser: { email: 'maya@example.com' } },
      { verifyOtp: { email: 'maya@example.com', token: '123456', type: 'email_change' } },
    ])
  })

  it('rejects malformed input before any round trip and maps auth errors', async () => {
    const { auth, calls } = fakeAuth()
    await expect(startCredentialChange(auth, 'email', 'nope')).rejects.toBeInstanceOf(EarthError)
    expect(calls).toEqual([])
    const failing = fakeAuth({ message: 'rate limit exceeded', status: 429 })
    await expect(
      startCredentialChange(failing.auth, 'phone', '+14155550100'),
    ).rejects.toBeInstanceOf(EarthError)
  })
})
