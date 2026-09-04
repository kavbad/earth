/**
 * The world the spec §115 integration flows run in (`flows.test.ts`): one scratch database, the
 * server tier mounted over it (`server-deps.ts`) and helpers that drive the product exactly the
 * way clients do — public RPCs as a specific caller, `GET /api/feed`, `POST /api/rooms/:id/token`
 * and the claim verification routes through the real handlers — parsing every answer with the
 * very `@earth/domain` schema the typed client parses with.
 *
 * Nothing here reaches into tables except to mint supporting actors (`human`: an active Human
 * row with a public identity) and the credentials the flows start from (`auth.users`).
 */
import {
  ClaimCompleteDtoSchema,
  ClaimStateDtoSchema,
  ConversationSummaryDtoSchema,
  ConversationsListDtoSchema,
  FeedPageDtoSchema,
  GroupDetailDtoSchema,
  GroupInvitePreviewDtoSchema,
  MeDtoSchema,
  MediaGrantDtoSchema,
  MessageDtoSchema,
  MessagesPageDtoSchema,
  NotificationsPageDtoSchema,
  PostDetailDtoSchema,
  PostViewDtoSchema,
  ProfileDtoSchema,
  RelationshipChangeDtoSchema,
  RoomDtoSchema,
  RoomTokenDtoSchema,
  SearchResultsDtoSchema,
  VerificationSessionDtoSchema,
  type ClaimCompleteDto,
  type ClaimStateDto,
  type ConversationSummaryDto,
  type FeedPageDto,
  type GroupDetailDto,
  type GroupInvitePreviewDto,
  type MeDto,
  type MediaGrantDto,
  type MessageDto,
  type MessagesPageDto,
  type NotificationDto,
  type NotificationType,
  type PostDetailDto,
  type PostViewDto,
  type ProfileDto,
  type RoomDto,
  type SearchResultsDto,
  type VerificationSessionDto,
} from '@earth/domain'
import { TokenVerifier, type ClaimGrants } from 'livekit-server-sdk'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import { createUnclaimed, type Human } from '../admission/fixtures'
import { createTestDb, type RoleSpec, type TestDb } from '../harness'
import { human } from '../rooms/fixtures'
import {
  TEST_LIVEKIT,
  createEarthServer,
  createServerTestDeps,
  fakeRequest,
  type EarthResponse,
  type EarthServer,
  type ServerTestDeps,
} from './server-deps'

export { createGuest, type Human } from '../admission/fixtures'
export { human, type Guest } from '../rooms/fixtures'
export { errorCodeOf } from './server-deps'

export interface World {
  readonly db: TestDb
  readonly ctx: ServerTestDeps
  readonly server: EarthServer
}

/** A scratch database with the server tier mounted over it. */
export async function createWorld(): Promise<World> {
  const db = await createTestDb()
  const ctx = createServerTestDeps(db)
  return { db, ctx, server: createEarthServer(ctx.deps) }
}

/** The machine code a promise rejects with, or `null` when it resolves. */
export async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise
    return null
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
}

/** A bearer the server tier resolves to this caller. */
export function bearerFor(world: World, as: RoleSpec): string {
  return world.ctx.tokens.for(as)
}

// ---------------------------------------------------------------------------------------------------
// Claim (spec §44–§48)
// ---------------------------------------------------------------------------------------------------

/** A real credential (email sign-in) that has not started a claim. */
export interface Credential {
  readonly userId: string
  readonly as: RoleSpec
}

export async function newCredential(world: World): Promise<Credential> {
  return createUnclaimed(world.db)
}

export async function claimStart(
  world: World,
  who: Credential,
  args:
    { intent: 'start_group'; groupLabel: string } | { intent: 'join_group'; inviteToken: string },
): Promise<ClaimStateDto> {
  const rpcArgs =
    args.intent === 'start_group'
      ? { intent: args.intent, group_label: args.groupLabel }
      : { intent: args.intent, invite_token: args.inviteToken }
  return ClaimStateDtoSchema.parse(await world.db.rpc('claim_start', rpcArgs, who.as))
}

export async function claimIdentity(
  world: World,
  who: Credential,
  displayName: string,
  handle: string,
): Promise<ClaimStateDto> {
  return ClaimStateDtoSchema.parse(
    await world.db.rpc('claim_set_identity', { display_name: displayName, handle }, who.as),
  )
}

export async function claimState(world: World, who: Credential): Promise<ClaimStateDto> {
  return ClaimStateDtoSchema.parse(await world.db.rpc('claim_get', {}, who.as))
}

/**
 * `POST /api/claim/verification/start` with the mock provider: the server begins the pass as the
 * caller and records the provider's answer through the service RPC, like production does.
 */
export async function verifyThroughServer(
  world: World,
  who: Credential,
  hint: 'verified' | 'duplicate' | 'rejected' | 'inconclusive' = 'verified',
): Promise<VerificationSessionDto> {
  const res = await world.server.handle(
    fakeRequest({
      method: 'POST',
      url: '/api/claim/verification/start',
      bearer: bearerFor(world, who.as),
      body: { locale: 'en-US', platform: 'web', hint },
    }),
  )
  if (res.status !== 200) {
    throw new Error(`verification start answered ${res.status}: ${JSON.stringify(res.body)}`)
  }
  return VerificationSessionDtoSchema.parse(res.body)
}

export async function claimComplete(world: World, who: Credential): Promise<ClaimCompleteDto> {
  return ClaimCompleteDtoSchema.parse(await world.db.rpc('claim_complete', {}, who.as))
}

export interface ClaimedHuman extends Human {
  readonly groupId: string
  readonly conversationId: string
}

/** A Human that came to Earth the real way: claim → identity → verification → own group. */
export async function claimNewHuman(
  world: World,
  input: { displayName: string; handle: string; groupLabel: string },
): Promise<ClaimedHuman> {
  const who = await newCredential(world)
  const started = await claimStart(world, who, {
    intent: 'start_group',
    groupLabel: input.groupLabel,
  })
  await claimIdentity(world, who, input.displayName, input.handle)
  await verifyThroughServer(world, who)
  const done = await claimComplete(world, who)
  return {
    userId: who.userId,
    humanId: started.humanId,
    handle: input.handle,
    displayName: input.displayName,
    as: who.as,
    groupId: done.groupId,
    conversationId: done.conversationId,
  }
}

/** An active Human minted directly (a supporting actor, not a flow under test). */
export async function existingHuman(world: World, name: string): Promise<Human> {
  return human(world.db, name)
}

// ---------------------------------------------------------------------------------------------------
// Identity and social
// ---------------------------------------------------------------------------------------------------

export async function me(world: World, as: RoleSpec): Promise<MeDto> {
  return MeDtoSchema.parse(await world.db.rpc('me_get', {}, as))
}

export async function profile(world: World, as: RoleSpec, handle: string): Promise<ProfileDto> {
  return ProfileDtoSchema.parse(await world.db.rpc('profile_get', { handle }, as))
}

/** Friendship the product way: a request from `requester`, accepted by `target`. */
export async function makeFriends(world: World, requester: Human, target: Human): Promise<void> {
  const sent = RelationshipChangeDtoSchema.parse(
    await world.db.rpc('friend_request_send', { target_human_id: target.humanId }, requester.as),
  )
  if (sent.isFriend) return
  const accepted = RelationshipChangeDtoSchema.parse(
    await world.db.rpc('friend_request_accept', { source_human_id: requester.humanId }, target.as),
  )
  if (!accepted.isFriend) throw new Error('friend_request_accept did not create the friendship')
}

export async function search(world: World, as: RoleSpec, q: string): Promise<SearchResultsDto> {
  return SearchResultsDtoSchema.parse(await world.db.rpc('search', { q, limit: 20 }, as))
}

// ---------------------------------------------------------------------------------------------------
// Groups and conversations
// ---------------------------------------------------------------------------------------------------

export async function groupDetail(
  world: World,
  as: RoleSpec,
  groupId: string,
): Promise<GroupDetailDto> {
  return GroupDetailDtoSchema.parse(await world.db.rpc('group_get', { group_id: groupId }, as))
}

export async function invitePreview(
  world: World,
  as: RoleSpec,
  token: string,
): Promise<GroupInvitePreviewDto> {
  return GroupInvitePreviewDtoSchema.parse(
    await world.db.rpc('group_invite_preview', { token }, as),
  )
}

export async function conversations(world: World, as: RoleSpec): Promise<ConversationSummaryDto[]> {
  return ConversationsListDtoSchema.parse(await world.db.rpc('conversations_list', {}, as))
    .conversations
}

export async function directConversation(
  world: World,
  as: RoleSpec,
  otherHumanId: string,
): Promise<ConversationSummaryDto> {
  return ConversationSummaryDtoSchema.parse(
    await world.db.rpc('conversation_direct_get_or_create', { other_human_id: otherHumanId }, as),
  )
}

export async function sendText(
  world: World,
  as: RoleSpec,
  conversationId: string,
  text: string,
  clientId: string = randomUUID(),
): Promise<MessageDto> {
  return MessageDtoSchema.parse(
    await world.db.rpc(
      'message_send',
      { conversation_id: conversationId, client_id: clientId, type: 'text', text },
      as,
    ),
  )
}

/** The polling fallback of `@earth/realtime`: everything after `afterId` (or the newest page). */
export async function messagesSince(
  world: World,
  as: RoleSpec,
  conversationId: string,
  afterId: string | null = null,
): Promise<MessagesPageDto> {
  return MessagesPageDtoSchema.parse(
    await world.db.rpc(
      'messages_since',
      { conversation_id: conversationId, after_id: afterId },
      as,
    ),
  )
}

export const ReadReceiptSchema = z.object({
  humanId: z.uuid(),
  lastReadMessageId: z.uuid().nullable(),
})

export async function readReceipts(
  world: World,
  as: RoleSpec,
  conversationId: string,
): Promise<Array<z.infer<typeof ReadReceiptSchema>>> {
  return z
    .array(ReadReceiptSchema)
    .parse(
      await world.db.rpc('conversation_read_receipts', { conversation_id: conversationId }, as),
    )
}

// ---------------------------------------------------------------------------------------------------
// Rooms, Live, Guests
// ---------------------------------------------------------------------------------------------------

export async function room(world: World, as: RoleSpec, roomId: string): Promise<RoomDto> {
  return RoomDtoSchema.parse(await world.db.rpc('room_get', { room_id: roomId }, as))
}

export async function joinRoom(
  world: World,
  as: RoleSpec,
  roomId: string,
  mediaState: 'watching' | 'audio' | 'camera',
  consentLevel: string,
): Promise<RoomDto> {
  return RoomDtoSchema.parse(
    await world.db.rpc(
      'room_join',
      { room_id: roomId, media_state: mediaState, consent_level: consentLevel },
      as,
    ),
  )
}

const LiveListSchema = z.object({
  candidates: z.array(z.object({ roomId: z.uuid() })),
})

/** Room ids of `live_candidates(scope)` for the caller, sorted. */
export async function liveRoomIds(world: World, as: RoleSpec, scope: string): Promise<string[]> {
  const list = LiveListSchema.parse(
    await world.db.rpc('live_candidates', { scope, area_id: null }, as),
  )
  return list.candidates.map((c) => c.roomId).sort()
}

export async function mediaGrant(
  world: World,
  as: RoleSpec,
  roomId: string,
): Promise<MediaGrantDto> {
  return MediaGrantDtoSchema.parse(await world.db.rpc('room_media_grant', { room_id: roomId }, as))
}

/** `POST /api/rooms/:id/token` as the caller (`undefined`: no bearer at all). */
export async function mediaToken(
  world: World,
  as: RoleSpec | undefined,
  roomId: string,
): Promise<EarthResponse> {
  return world.server.handle(
    fakeRequest({
      method: 'POST',
      url: `/api/rooms/${roomId}/token`,
      ...(as === undefined ? {} : { bearer: bearerFor(world, as) }),
    }),
  )
}

const verifier = new TokenVerifier(TEST_LIVEKIT.apiKey, TEST_LIVEKIT.apiSecret)

/** The verified LiveKit claims of a 200 token response. */
export async function tokenClaims(res: EarthResponse): Promise<ClaimGrants> {
  if (res.status !== 200)
    throw new Error(`token route answered ${res.status}: ${JSON.stringify(res.body)}`)
  return verifier.verify(RoomTokenDtoSchema.parse(res.body).token)
}

// ---------------------------------------------------------------------------------------------------
// Feed and posts
// ---------------------------------------------------------------------------------------------------

/** `GET /api/feed?scope=` as the caller (`null`: a Visitor without a bearer). */
export async function feedPage(
  world: World,
  as: RoleSpec | null,
  scope: 'friends' | 'neighborhood' | 'city' | 'world',
): Promise<FeedPageDto> {
  // The snapshot is the server clock; keep it just ahead of the database clock so every row so far counts.
  world.ctx.clock.now = new Date(Date.now() + 1_000)
  const res = await world.server.handle(
    fakeRequest({
      url: `/api/feed?scope=${scope}`,
      ...(as === null ? {} : { bearer: bearerFor(world, as) }),
    }),
  )
  if (res.status !== 200)
    throw new Error(`feed answered ${res.status}: ${JSON.stringify(res.body)}`)
  return FeedPageDtoSchema.parse(res.body)
}

/** Card ids of the first feed page (post ids and room ids). */
export async function feedCardIds(
  world: World,
  as: RoleSpec | null,
  scope: 'friends' | 'neighborhood' | 'city' | 'world',
): Promise<string[]> {
  return (await feedPage(world, as, scope)).cards.map((card) => card.id)
}

const CandidateIdsSchema = z.object({ candidates: z.array(z.object({ id: z.uuid() })) })

/** Ids of the raw `feed_candidates(scope)` pool for the caller. */
export async function feedCandidateIds(
  world: World,
  as: RoleSpec,
  scope: 'friends' | 'neighborhood' | 'city' | 'world',
): Promise<string[]> {
  return CandidateIdsSchema.parse(
    await world.db.rpc(
      'feed_candidates',
      { scope, area_id: null, snapshot_at: null, limit: null },
      as,
    ),
  ).candidates.map((c) => c.id)
}

export interface PostInput {
  text: string
  audience: 'friends' | 'neighborhood' | 'city' | 'world'
  parentPostId?: string | null
}

export async function createPost(
  world: World,
  as: RoleSpec,
  input: PostInput,
): Promise<PostViewDto> {
  return PostViewDtoSchema.parse(
    await world.db.rpc(
      'post_create',
      {
        type: 'text',
        text: input.text,
        audience: input.audience,
        area_id: null,
        place_id: null,
        media: [],
        reply_policy: 'everyone_eligible',
        reshare_policy: 'allowed_within_audience',
        parent_post_id: input.parentPostId ?? null,
        provenance: null,
      },
      as,
    ),
  )
}

export async function postDetail(
  world: World,
  as: RoleSpec,
  postId: string,
): Promise<PostDetailDto> {
  return PostDetailDtoSchema.parse(await world.db.rpc('post_get', { post_id: postId }, as))
}

const PostsByAuthorSchema = z.object({ posts: z.array(PostViewDtoSchema) })

export async function postsByAuthor(world: World, as: RoleSpec, handle: string): Promise<string[]> {
  return PostsByAuthorSchema.parse(
    await world.db.rpc('posts_by_author', { handle, cursor: null, limit: 50 }, as),
  ).posts.map((view) => view.post.id)
}

// ---------------------------------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------------------------------

/** Every notification of the caller (`notifications_list`, all pages). */
export async function notifications(world: World, as: RoleSpec): Promise<NotificationDto[]> {
  const items: NotificationDto[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 50; guard += 1) {
    const page = NotificationsPageDtoSchema.parse(
      await world.db.rpc('notifications_list', { cursor, limit: 100 }, as),
    )
    items.push(...page.notifications)
    if (page.nextCursor === null) return items
    cursor = page.nextCursor
  }
  throw new Error('notifications_list did not terminate')
}

/** The caller's Live notifications about one room, oldest first. */
export async function liveNotificationsFor(
  world: World,
  as: RoleSpec,
  roomId: string,
): Promise<NotificationDto[]> {
  const live: NotificationType[] = ['friend_live', 'multi_live', 'group_live']
  return (await notifications(world, as))
    .filter((n) => live.includes(n.type) && n.payload['roomId'] === roomId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function unreadCount(world: World, as: RoleSpec): Promise<number> {
  return z
    .object({ unreadCount: z.int().min(0) })
    .parse(await world.db.rpc('notifications_unread_count', {}, as)).unreadCount
}
