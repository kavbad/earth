/**
 * `flags`, `settings`, `me`, `claim`, `identity` and `media` (DB_API §1, §8; ARCHITECTURE §4, §6).
 */
import { type FeatureFlags, resolveFlags } from '@earth/config'
import {
  type ClaimCompleteDto,
  type ClaimIdentityInput,
  ClaimIdentityInputSchema,
  ClaimStartInputSchema,
  type ClaimStateDto,
  EarthError,
  type FlagsDto,
  type MeDto,
  type PublicIdentityDto,
  type VerificationSessionDto,
} from '@earth/domain'
import { z } from 'zod'

import {
  type AccountDeleteDto,
  AppSettingRowsSchema,
  FeatureFlagRowsSchema,
  HandleLookupSchema,
  type IdentityReviewCreateInput,
  IdentityReviewCreateInputSchema,
  type IdentityReviewDto,
  type IdentityUpdateInput,
  IdentityUpdateInputSchema,
  type MediaBucket,
  MediaBucketSchema,
  type MediaObjectDto,
  MediaObjectDtoSchema,
  MediaObjectRowSchema,
  type MediaUploadInput,
  MediaUploadInputSchema,
  type SettingsDto,
  type VerificationBeginDto,
  type VerificationResultDto,
  type VerificationStartInput,
  VerificationStartInputSchema,
  flagsDtoFromRows,
  settingsFromRows,
} from '../dto'
import { CALLS } from '../manifest'
import { STORAGE_BUCKETS } from '../rpc'
import { type Transport, parseInput, parseOutput } from '../transport'
import type { StorageBody } from '../types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlagsNamespace {
  /** `feature_flags` rows keyed by flag key (ARCHITECTURE §12); readable by everyone. */
  get(): Promise<FlagsDto>
  /** The boolean map over the launch defaults (`resolveFlags` from `@earth/config`). */
  resolved(): Promise<FeatureFlags>
}

export interface SettingsNamespace {
  /** `app_settings` (`public_storage_base_url`, `room_grace_seconds`, `web_origin`). */
  get(): Promise<SettingsDto>
}

export interface MeNamespace {
  /** `me_get()`: who the caller is in the four states of ARCHITECTURE §4. */
  get(): Promise<MeDto>
}

export type ClaimStartInputLike = z.input<typeof ClaimStartInputSchema>

export interface ClaimNamespace {
  /** `claim_start(intent, group_label, invite_token)`. */
  start(input: ClaimStartInputLike): Promise<ClaimStateDto>
  /** `claim_get()`. */
  get(): Promise<ClaimStateDto>
  /** `claim_set_identity(display_name, handle, avatar_media_id)`. */
  setIdentity(input: ClaimIdentityInput): Promise<ClaimStateDto>
  /** `claim_verification_begin(provider)`; normally called by the server route on the caller's behalf. */
  beginVerification(provider?: string): Promise<VerificationBeginDto>
  /** `POST /api/claim/verification/start` (server tier runs the provider). */
  startVerification(input: VerificationStartInput): Promise<VerificationSessionDto>
  /**
   * `GET /api/claim/verification/:sessionId` (ARCHITECTURE §7 `pollVerification`): the recorded
   * status and, when it failed, `failureKind` — the route answers `VerificationResultDto`, not the
   * start route's `VerificationSessionDto`.
   */
  pollVerification(sessionId: string): Promise<VerificationResultDto>
  /** Same as {@link ClaimNamespace.pollVerification}. */
  verificationResult(sessionId: string): Promise<VerificationResultDto>
  /** `claim_complete()`: Human + group + membership + conversation in one transaction. */
  complete(): Promise<ClaimCompleteDto>
  /** `identity_review_create(kind, details)`: "This isn't me", "I need help", safety, recovery. */
  createReview(input: IdentityReviewCreateInput): Promise<IdentityReviewDto>
}

export interface AvatarUploadInput {
  readonly body: StorageBody
  readonly contentType: string
  readonly width?: number | null | undefined
  readonly height?: number | null | undefined
  readonly byteSize?: number | null | undefined
}

export interface IdentityNamespace {
  /** `identity_update(...)`: only the fields given change; `handle` changes the handle (`handle_invalid` / `handle_taken`). */
  update(input: IdentityUpdateInput): Promise<PublicIdentityDto>
  /** `handle_available(handle)` after case/`@` normalization; handles malformed beyond that are `false` without a round trip. */
  handleAvailable(handle: string): Promise<boolean>
  /** Uploads to the `avatars` bucket and registers the `media_objects` row; pass `id` to `claim.setIdentity` / `identity.update`. */
  uploadAvatar(input: AvatarUploadInput): Promise<MediaObjectDto>
  /**
   * `POST /api/account/delete`: the server runs `human_delete_request` as the caller (the Human is
   * deleted and invisible everywhere; the same credential may claim again as a new Human) and then
   * deletes the credential through the Supabase admin API. Sign out afterwards.
   */
  deleteAccount(): Promise<AccountDeleteDto>
}

export interface MediaNamespace {
  /** Storage upload under `<human_id>/<random>.<ext>` plus the `media_objects` insert RLS allows for own objects. */
  upload(body: StorageBody, input: MediaUploadInput): Promise<MediaObjectDto>
  /** Signed URL for a private bucket object the caller may read. */
  signedUrl(bucket: MediaBucket, storageKey: string, expiresInSeconds?: number): Promise<string>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flags DTO (from `me_get` or `flags.get`) → the boolean map with launch defaults. */
export function featureFlagsFromDto(flags: FlagsDto): FeatureFlags {
  return resolveFlags(
    Object.entries(flags).map(([key, value]) => ({ key, enabled: value.enabled })),
  )
}

const EXTENSION_BY_CONTENT_TYPE: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
}

/** File extension for a storage key: known media types map to their usual extension. */
export function extensionForContentType(contentType: string): string {
  const known = EXTENSION_BY_CONTENT_TYPE[contentType]
  if (known !== undefined) return known
  const subtype = contentType.split('/')[1] ?? ''
  const cleaned = subtype.replace(/[^a-z0-9]/g, '')
  return cleaned.length > 0 ? cleaned : 'bin'
}

export const DEFAULT_SIGNED_URL_SECONDS = 3600

const SignedUrlExpirySchema = z
  .int()
  .min(1)
  .max(7 * 24 * 3600)
const SessionIdSchema = z.string().min(1)
const ProviderSchema = z.string().min(1)
const StorageKeySchema = z.string().min(1).max(512)
const FLAG_COLUMNS = CALLS.flagsGet.args.join(', ')
const SETTING_COLUMNS = CALLS.settingsGet.args.join(', ')
const MEDIA_OBJECT_COLUMNS = 'id, bucket, storage_key, content_type' as const

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createFlagsNamespace(transport: Transport): FlagsNamespace {
  const rows = () =>
    transport.query(
      `select ${CALLS.flagsGet.table}`,
      (table) => table.select(FLAG_COLUMNS),
      CALLS.flagsGet.table,
      FeatureFlagRowsSchema,
    )
  return {
    get: async () => flagsDtoFromRows(await rows()),
    resolved: async () =>
      resolveFlags((await rows()).map((r) => ({ key: r.key, enabled: r.enabled }))),
  }
}

export function createSettingsNamespace(transport: Transport): SettingsNamespace {
  return {
    get: async () =>
      settingsFromRows(
        await transport.query(
          `select ${CALLS.settingsGet.table}`,
          (table) => table.select(SETTING_COLUMNS),
          CALLS.settingsGet.table,
          AppSettingRowsSchema,
        ),
      ),
  }
}

export function createMeNamespace(transport: Transport): MeNamespace {
  return { get: () => transport.call(CALLS.meGet, {}) }
}

export function createClaimNamespace(transport: Transport): ClaimNamespace {
  const pollVerification = (sessionId: string): Promise<VerificationResultDto> => {
    const id = parseInput(SessionIdSchema, sessionId, 'sessionId')
    return transport.route(CALLS.claimPollVerification, { params: { sessionId: id } })
  }
  return {
    start(input) {
      const parsed = parseInput(ClaimStartInputSchema, input)
      return transport.call(CALLS.claimStart, {
        intent: parsed.intent,
        group_label: parsed.groupLabel ?? null,
        invite_token: parsed.inviteToken ?? null,
      })
    },
    get: () => transport.call(CALLS.claimGet, {}),
    setIdentity(input) {
      const parsed = parseInput(ClaimIdentityInputSchema, input)
      return transport.call(CALLS.claimSetIdentity, {
        display_name: parsed.displayName,
        handle: parsed.handle,
        avatar_media_id: parsed.avatarMediaId ?? null,
      })
    },
    beginVerification(provider) {
      return transport.call(CALLS.claimBeginVerification, {
        // Only sent when given: the RPC defaults it (an `undefined` argument is dropped).
        provider:
          provider === undefined ? undefined : parseInput(ProviderSchema, provider, 'provider'),
      })
    },
    startVerification(input) {
      const body = parseInput(VerificationStartInputSchema, input)
      return transport.route(CALLS.claimStartVerification, { body })
    },
    pollVerification,
    verificationResult: pollVerification,
    complete: () => transport.call(CALLS.claimComplete, {}),
    createReview(input) {
      const parsed = parseInput(IdentityReviewCreateInputSchema, input)
      return transport.call(CALLS.claimCreateReview, { kind: parsed.kind, details: parsed.details })
    },
  }
}

export function createMediaNamespace(transport: Transport): MediaNamespace {
  return {
    async upload(body, input) {
      const parsed = parseInput(MediaUploadInputSchema, input)
      const me = await transport.call(CALLS.meGet, {})
      if (me.humanId === null) {
        throw new EarthError('not_a_human', { details: { reason: 'media_upload_needs_human' } })
      }
      const storageKey = `${me.humanId}/${transport.randomId()}.${extensionForContentType(parsed.contentType)}`
      const bucket = transport.supabase.storage.from(parsed.bucket)
      const uploaded = await bucket.upload(storageKey, body, {
        contentType: parsed.contentType,
        upsert: false,
      })
      if (uploaded.error !== null) {
        throw new EarthError('internal', {
          details: { reason: 'storage_upload_failed', bucket: parsed.bucket },
          cause: uploaded.error,
          message: `storage upload failed: ${uploaded.error.message}`,
        })
      }
      const row = await transport.query(
        `insert ${CALLS.mediaUpload.table}`,
        (table) =>
          table
            .insert({
              owner_human_id: me.humanId,
              bucket: parsed.bucket,
              storage_key: storageKey,
              content_type: parsed.contentType,
              width: parsed.width ?? null,
              height: parsed.height ?? null,
              duration_ms: parsed.durationMs ?? null,
              byte_size: parsed.byteSize ?? null,
            })
            .select(MEDIA_OBJECT_COLUMNS)
            .single(),
        CALLS.mediaUpload.table,
        MediaObjectRowSchema,
      )
      const url =
        parsed.bucket === STORAGE_BUCKETS.avatars
          ? bucket.getPublicUrl(storageKey).data.publicUrl
          : null
      return parseOutput(
        MediaObjectDtoSchema,
        {
          id: row.id,
          bucket: row.bucket,
          storageKey: row.storage_key,
          contentType: row.content_type,
          url,
        },
        'media object',
      )
    },
    async signedUrl(bucket, storageKey, expiresInSeconds = DEFAULT_SIGNED_URL_SECONDS) {
      const bucketName = parseInput(MediaBucketSchema, bucket, 'bucket')
      const key = parseInput(StorageKeySchema, storageKey, 'storageKey')
      const expiresIn = parseInput(SignedUrlExpirySchema, expiresInSeconds, 'expiresInSeconds')
      const result = await transport.supabase.storage
        .from(bucketName)
        .createSignedUrl(key, expiresIn)
      if (result.error !== null || result.data === null) {
        throw new EarthError('internal', {
          details: { reason: 'signed_url_failed', bucket: bucketName },
          cause: result.error,
          message: `signed url failed: ${result.error?.message ?? 'no data'}`,
        })
      }
      return result.data.signedUrl
    },
  }
}

export function createIdentityNamespace(
  transport: Transport,
  media: MediaNamespace,
): IdentityNamespace {
  return {
    update(input) {
      const parsed = parseInput(IdentityUpdateInputSchema, input)
      return transport.call(CALLS.identityUpdate, {
        display_name: parsed.displayName ?? null,
        bio: parsed.bio ?? null,
        avatar_media_id: parsed.avatarMediaId ?? null,
        profile_visibility: parsed.profileVisibility ?? null,
        public_city_visibility: parsed.publicCityVisibility ?? null,
        home_city_area_id: parsed.homeCityAreaId ?? null,
        handle: parsed.handle ?? null,
      })
    },
    deleteAccount() {
      return transport.route(CALLS.identityDeleteAccount, { body: {} })
    },
    async handleAvailable(handle) {
      const candidate = HandleLookupSchema.safeParse(handle)
      if (!candidate.success) return false
      return transport.call(CALLS.identityHandleAvailable, { handle: candidate.data })
    },
    uploadAvatar(input) {
      return media.upload(input.body, {
        bucket: STORAGE_BUCKETS.avatars,
        contentType: input.contentType,
        width: input.width ?? null,
        height: input.height ?? null,
        byteSize: input.byteSize ?? null,
      })
    },
  }
}
