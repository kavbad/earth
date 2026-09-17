/**
 * `POST /api/account/delete` (DB_API §1 `human_delete_request`; spec §80): the caller's Human is
 * deleted by the RPC **as the caller** (the database decides who may delete what), then the
 * credential is removed through the Supabase admin API so nothing can sign in as it again. The
 * Human deletion is the contract; a credential that could not be deleted is reported
 * (`credentialDeleted: false`) and logged — never a failed response, since the Human is already
 * gone and the client must sign out either way.
 */
import { HumanIdSchema, IsoDateTimeSchema } from '@earth/domain'
import { z } from 'zod'

import type { ServerDeps } from '../deps'
import { type EarthRequest, type EarthResponse, ok, requireBearer, rpc } from '../http'

export const HUMAN_DELETE_REQUEST_RPC = 'human_delete_request' as const

export const ACCOUNT_DELETE_LOG = {
  deleted: 'account.deleted',
  credentialUnavailable: 'account.credential_delete_unavailable',
  credentialFailed: 'account.credential_delete_failed',
} as const

/** What `human_delete_request()` answers. */
export const HumanDeleteResultSchema = z.object({
  humanId: HumanIdSchema,
  authUserId: z.uuid(),
  deletedAt: IsoDateTimeSchema,
})
export type HumanDeleteResult = z.infer<typeof HumanDeleteResultSchema>

/** The route's body (the `AccountDeleteDto` of `@earth/api`). */
export const AccountDeleteResponseSchema = z.object({
  humanId: HumanIdSchema,
  deletedAt: IsoDateTimeSchema,
  credentialDeleted: z.boolean(),
})
export type AccountDeleteResponse = z.infer<typeof AccountDeleteResponseSchema>

export async function handleAccountDelete(
  deps: ServerDeps,
  req: EarthRequest,
): Promise<EarthResponse> {
  const token = requireBearer(req)
  const result = await rpc(deps, token, HUMAN_DELETE_REQUEST_RPC, {}, HumanDeleteResultSchema)
  const logger = deps.logger.child({ route: 'account.delete', humanId: result.humanId })
  let credentialDeleted = false
  if (deps.authAdmin === undefined) {
    logger.warn(ACCOUNT_DELETE_LOG.credentialUnavailable, { authUserId: result.authUserId })
  } else {
    try {
      const { error } = await deps.authAdmin.deleteUser(result.authUserId)
      if (error === null) credentialDeleted = true
      else
        logger.error(ACCOUNT_DELETE_LOG.credentialFailed, {
          authUserId: result.authUserId,
          message: error.message,
        })
    } catch (cause) {
      logger.error(ACCOUNT_DELETE_LOG.credentialFailed, {
        authUserId: result.authUserId,
        error: cause,
      })
    }
  }
  logger.info(ACCOUNT_DELETE_LOG.deleted, { credentialDeleted })
  const body: AccountDeleteResponse = {
    humanId: result.humanId,
    deletedAt: result.deletedAt,
    credentialDeleted,
  }
  return ok(body)
}
