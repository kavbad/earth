/**
 * The Human verification provider of the mounted server tier (ARCHITECTURE §6 `ServerDeps.
 * verification`, §14): `createVerificationProvider` of `@earth/auth` chooses the adapter for
 * `HUMAN_VERIFICATION_PROVIDER` (and refuses `mock` in production).
 *
 * `manual_review` needs two callbacks over `identity_reviews` (DB_API §1). They run on the
 * service-role client: the review is opened on behalf of the claiming Human by the server, and
 * its status is read back by review id (the verification session id). The client is described
 * structurally so tests pass a fake table.
 */
import {
  type CreateReviewInput,
  type CreateReviewOutput,
  type HumanVerificationProvider,
  type IdentityReviewStatus,
  IdentityReviewStatusSchema,
  IdentityReviewStatuses,
  type VerificationProviderDeps,
  createVerificationProvider,
} from '@earth/auth'
import type { ServerEnv } from '@earth/config'
import { EarthError } from '@earth/domain'
import { z } from 'zod'

export const IDENTITY_REVIEWS_TABLE = 'identity_reviews' as const

/** The `identity_reviews` columns the server writes (DB_API §1). */
export interface IdentityReviewInsert {
  readonly human_id: string
  readonly kind: string
  readonly status: IdentityReviewStatus
  readonly details: Readonly<Record<string, unknown>>
}

export interface TableResult {
  readonly data: unknown
  readonly error: { readonly message: string } | null
}

/** The PostgREST builder chain used here, structurally (`SupabaseClient.from(...)` satisfies it). */
export interface IdentityReviewsTableLike {
  insert(row: IdentityReviewInsert): {
    select(columns: string): { single(): PromiseLike<TableResult> }
  }
  select(columns: string): {
    eq(column: string, value: string): { maybeSingle(): PromiseLike<TableResult> }
  }
}

export interface SupabaseTableClientLike {
  from(table: string): IdentityReviewsTableLike
}

export type ManualReviewCallbacks = NonNullable<VerificationProviderDeps['manualReview']>

const ReviewIdRowSchema = z.object({ id: z.string().min(1) })
const ReviewStatusRowSchema = z.object({ status: IdentityReviewStatusSchema })

function tableFailure(what: string, error: { readonly message: string }): EarthError {
  return new EarthError('internal', { message: `${what} failed`, cause: error, details: { what } })
}

export function createIdentityReviewCallbacks(client: SupabaseTableClientLike): ManualReviewCallbacks {
  return {
    async createReview(input: CreateReviewInput): Promise<CreateReviewOutput> {
      const row: IdentityReviewInsert = {
        human_id: input.humanId,
        kind: input.kind,
        status: IdentityReviewStatuses.open,
        details: { humanPassId: input.humanPassId, locale: input.locale, platform: input.platform },
      }
      const result = await client.from(IDENTITY_REVIEWS_TABLE).insert(row).select('id').single()
      if (result.error !== null) throw tableFailure('identity_reviews insert', result.error)
      const parsed = ReviewIdRowSchema.safeParse(result.data)
      if (!parsed.success) {
        throw new EarthError('internal', {
          message: 'identity_reviews insert returned no id',
          cause: parsed.error,
        })
      }
      return { reviewId: parsed.data.id }
    },
    async getReviewStatus(reviewId: string): Promise<IdentityReviewStatus | null> {
      const result = await client
        .from(IDENTITY_REVIEWS_TABLE)
        .select('status')
        .eq('id', reviewId)
        .maybeSingle()
      if (result.error !== null) throw tableFailure('identity_reviews select', result.error)
      if (result.data === null || result.data === undefined) return null
      const parsed = ReviewStatusRowSchema.safeParse(result.data)
      if (!parsed.success) {
        throw new EarthError('internal', {
          message: 'identity_reviews row does not match its shape',
          cause: parsed.error,
        })
      }
      return parsed.data.status
    },
  }
}

export interface VerificationProviderOptions {
  readonly supabaseAdmin: SupabaseTableClientLike
  readonly now?: (() => Date) | undefined
}

/** The provider for `env.HUMAN_VERIFICATION_PROVIDER` with the review callbacks wired. */
export function createVerificationProviderFromEnv(
  env: ServerEnv,
  options: VerificationProviderOptions,
): HumanVerificationProvider {
  return createVerificationProvider(env, {
    manualReview: createIdentityReviewCallbacks(options.supabaseAdmin),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
}
