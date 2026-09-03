import { describe, expect, it } from 'vitest'

import { createEarthServer } from '../router'
import { TEST_HUMAN_ID, createFakeDeps, fakeRequest, rpcFailure } from '../test/fakes'
import { ACCOUNT_DELETE_LOG, HUMAN_DELETE_REQUEST_RPC, handleAccountDelete } from './delete'

const AUTH_USER_ID = '99999999-9999-4999-8999-999999999999'
const DELETED_AT = '2026-09-03T12:00:00.000+00:00'

function deletion() {
  return { humanId: TEST_HUMAN_ID, authUserId: AUTH_USER_ID, deletedAt: DELETED_AT }
}

describe('POST /api/account/delete', () => {
  it('runs human_delete_request as the caller, then deletes the credential through auth.admin', async () => {
    const { deps, supabase, logs } = createFakeDeps({
      rpc: { [HUMAN_DELETE_REQUEST_RPC]: () => deletion() },
    })
    const deleted: string[] = []
    const response = await handleAccountDelete(
      {
        ...deps,
        authAdmin: {
          deleteUser: async (userId) => {
            deleted.push(userId)
            return { error: null }
          },
        },
      },
      fakeRequest({ method: 'POST', url: '/api/account/delete', bearer: 'tok', body: {} }),
    )
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      humanId: TEST_HUMAN_ID,
      deletedAt: DELETED_AT,
      credentialDeleted: true,
    })
    expect(supabase.calls).toEqual([
      { client: 'user:tok', name: HUMAN_DELETE_REQUEST_RPC, args: {} },
    ])
    expect(deleted).toEqual([AUTH_USER_ID])
    expect(logs.records.some((r) => r.msg === ACCOUNT_DELETE_LOG.deleted)).toBe(true)
  })

  it('refuses without a bearer and maps the RPC gate codes', async () => {
    const { deps } = createFakeDeps({
      rpc: {
        [HUMAN_DELETE_REQUEST_RPC]: () => {
          throw rpcFailure('not_a_human')
        },
      },
    })
    const server = createEarthServer(deps)
    const anonymous = await server.handle(
      fakeRequest({ method: 'POST', url: '/api/account/delete' }),
    )
    expect(anonymous.status).toBe(401)
    expect(anonymous.body).toMatchObject({ error: { code: 'not_authenticated' } })
    const claiming = await server.handle(
      fakeRequest({ method: 'POST', url: '/api/account/delete', bearer: 'tok' }),
    )
    expect(claiming.status).toBe(403)
    expect(claiming.body).toMatchObject({ error: { code: 'not_a_human' } })
  })

  it('reports credentialDeleted: false when the admin API is missing or fails, the Human being gone', async () => {
    const { deps, logs } = createFakeDeps({
      rpc: { [HUMAN_DELETE_REQUEST_RPC]: () => deletion() },
    })
    const without = await handleAccountDelete(
      deps,
      fakeRequest({ method: 'POST', url: '/api/account/delete', bearer: 'tok' }),
    )
    expect(without.status).toBe(200)
    expect(without.body).toMatchObject({ credentialDeleted: false })
    expect(logs.records.some((r) => r.msg === ACCOUNT_DELETE_LOG.credentialUnavailable)).toBe(true)

    const failing = await handleAccountDelete(
      { ...deps, authAdmin: { deleteUser: async () => ({ error: { message: 'gone already' } }) } },
      fakeRequest({ method: 'POST', url: '/api/account/delete', bearer: 'tok' }),
    )
    expect(failing.body).toMatchObject({ credentialDeleted: false })
    const throwing = await handleAccountDelete(
      {
        ...deps,
        authAdmin: {
          deleteUser: async () => {
            throw new Error('network')
          },
        },
      },
      fakeRequest({ method: 'POST', url: '/api/account/delete', bearer: 'tok' }),
    )
    expect(throwing.status).toBe(200)
    expect(throwing.body).toMatchObject({ humanId: TEST_HUMAN_ID, credentialDeleted: false })
    expect(
      logs.records.filter(
        (r) => r.level === 'error' && r.msg === ACCOUNT_DELETE_LOG.credentialFailed,
      ),
    ).toHaveLength(2)
  })

  it('a result that does not match the RPC contract is internal, never a partial answer', async () => {
    const { deps } = createFakeDeps({
      rpc: { [HUMAN_DELETE_REQUEST_RPC]: () => ({ humanId: TEST_HUMAN_ID }) },
    })
    const response = await createEarthServer(deps).handle(
      fakeRequest({ method: 'POST', url: '/api/account/delete', bearer: 'tok' }),
    )
    expect(response.status).toBe(500)
    expect(response.body).toMatchObject({ error: { code: 'internal' } })
  })
})
