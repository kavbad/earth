import { asPostId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { RPC } from './rpc'
import { earthRejection } from './testing/expect'
import { postgrestRaise } from './testing/fake-supabase'
import * as fixtures from './testing/fixtures'
import { createTestClient } from './testing/harness'

const { IDS } = fixtures
const POST = asPostId(IDS.post)

describe('posts', () => {
  it('create maps every argument, defaults policies and passes media object ids', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.postCreate, fixtures.postDto())
    const post = await client.posts.create({
      type: 'image',
      text: null,
      audience: 'city',
      placeId: IDS.place,
      media: [
        {
          mediaObjectId: IDS.media,
          storageKey: 'k/1.jpg',
          mediaType: 'image',
          width: 100,
          height: 80,
          durationMs: null,
          provenance: 'earth_capture',
        },
      ],
      parentPostId: null,
      clientId: IDS.client,
    })
    expect(supabase.lastRpc()).toEqual({
      name: 'post_create',
      args: {
        type: 'image',
        text: null,
        audience: 'city',
        area_id: null,
        place_id: IDS.place,
        media: [IDS.media],
        reply_policy: 'everyone_eligible',
        reshare_policy: 'allowed_within_audience',
        parent_post_id: null,
      },
    })
    expect(post.id).toBe(IDS.post)
  })

  it('create unwraps a PostViewDto result', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.postCreate, fixtures.postView())
    const post = await client.posts.create({
      type: 'text',
      text: 'hi',
      audience: 'friends',
      placeId: null,
      media: [],
      parentPostId: null,
    })
    expect(post.authorHumanId).toBe(IDS.xavier)
  })

  it('create rejects posts with neither text nor media and surfaces reply_not_allowed', async () => {
    const { client, supabase } = createTestClient()
    expect(
      (
        await earthRejection(
          client.posts.create({
            type: 'text',
            text: '  ',
            audience: 'friends',
            placeId: null,
            media: [],
            parentPostId: null,
          }),
        )
      ).code,
    ).toBe('invalid_input')
    expect(supabase.rpcCalls).toHaveLength(0)
    supabase.rpcError(RPC.postCreate, postgrestRaise('reply_not_allowed'))
    expect(
      (
        await earthRejection(
          client.posts.create({
            type: 'text',
            text: 'hi',
            audience: 'friends',
            placeId: null,
            media: [],
            parentPostId: IDS.post,
          }),
        )
      ).code,
    ).toBe('reply_not_allowed')
  })

  it('get returns the detail with replies', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.postGet, fixtures.postDetail())
    const detail = await client.posts.get(POST)
    expect(supabase.lastRpc()).toEqual({ name: 'post_get', args: { post_id: IDS.post } })
    expect(detail.replies[0]?.post.parentPostId).toBe(IDS.post)
  })

  it('delete, react and hide map their rpcs', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.postDelete, null)
    await client.posts.delete(POST)
    expect(supabase.lastRpc()).toEqual({ name: 'post_delete', args: { post_id: IDS.post } })
    supabase.rpcData(RPC.postReactionSet, null)
    await client.posts.react({ postId: POST, reaction: 'like' })
    expect(supabase.lastRpc()).toEqual({
      name: 'post_reaction_set',
      args: { post_id: IDS.post, reaction_type: 'like' },
    })
    await client.posts.react({ postId: POST, reaction: null })
    expect(supabase.lastRpc().args).toEqual({ post_id: IDS.post, reaction_type: null })
    supabase.rpcData(RPC.postHide, null)
    await client.posts.hide(POST)
    expect(supabase.lastRpc()).toEqual({ name: 'post_hide', args: { post_id: IDS.post } })
  })

  it('replies accepts a page or a bare array', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.postReplies, { replies: [fixtures.postView()], nextCursor: 'c2' })
    const page = await client.posts.replies({ postId: POST, cursor: 'c1', limit: 10 })
    expect(supabase.lastRpc()).toEqual({
      name: 'post_replies',
      args: { post_id: IDS.post, cursor: 'c1', limit: 10 },
    })
    expect(page.nextCursor).toBe('c2')
    supabase.rpcData(RPC.postReplies, [fixtures.postView()])
    expect(await client.posts.replies({ postId: POST })).toEqual({
      replies: [expect.objectContaining({ reactionCount: 4 })],
      nextCursor: null,
    })
    expect(supabase.lastRpc().args).toEqual({ post_id: IDS.post, cursor: null, limit: null })
  })
})
