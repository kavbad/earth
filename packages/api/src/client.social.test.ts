import { asHumanId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { RPC } from './rpc'
import { earthRejection } from './testing/expect'
import { postgrestRaise } from './testing/fake-supabase'
import * as fixtures from './testing/fixtures'
import { createTestClient } from './testing/harness'

const { IDS } = fixtures
const MAYA = asHumanId(IDS.maya)

describe('social', () => {
  it('profile calls profile_get(handle) and validates the handle', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.profileGet, fixtures.profileDto())
    const profile = await client.social.profile('maya')
    expect(supabase.lastRpc()).toEqual({ name: 'profile_get', args: { handle: 'maya' } })
    expect(profile.mutualFriendCount).toBe(8)
    // `/@Maya` links and typed handles: case and the leading `@` are folded, nothing else.
    await client.social.profile(' @Maya ')
    expect(supabase.lastRpc()).toEqual({ name: 'profile_get', args: { handle: 'maya' } })
    expect(supabase.rpcCalls).toHaveLength(2)
    expect((await earthRejection(client.social.profile('maya lee'))).code).toBe('invalid_input')
    expect((await earthRejection(client.social.profile('maya-lee'))).code).toBe('invalid_input')
    expect((await earthRejection(client.social.profile('@@maya'))).code).toBe('invalid_input')
    expect(supabase.rpcCalls).toHaveLength(2)
  })

  it('friend transactions map their rpcs and return RelationshipChangeDto', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.friendRequestSend, fixtures.relationshipChange())
    expect((await client.social.friendRequest(MAYA)).friendRequest).toBe('sent')
    expect(supabase.lastRpc()).toEqual({
      name: 'friend_request_send',
      args: { target_human_id: IDS.maya },
    })
    supabase.rpcData(
      RPC.friendRequestAccept,
      fixtures.relationshipChange({ isFriend: true, friendRequest: 'none' }),
    )
    expect((await client.social.acceptFriend(MAYA)).isFriend).toBe(true)
    expect(supabase.lastRpc()).toEqual({
      name: 'friend_request_accept',
      args: { source_human_id: IDS.maya },
    })
    supabase.rpcData(
      RPC.friendRequestDecline,
      fixtures.relationshipChange({ friendRequest: 'none' }),
    )
    await client.social.declineFriend(MAYA)
    expect(supabase.lastRpc()).toEqual({
      name: 'friend_request_decline',
      args: { source_human_id: IDS.maya },
    })
    supabase.rpcData(RPC.friendRemove, fixtures.relationshipChange({ friendRequest: 'none' }))
    await client.social.removeFriend(MAYA)
    expect(supabase.lastRpc()).toEqual({
      name: 'friend_remove',
      args: { other_human_id: IDS.maya },
    })
  })

  it('setFollow maps to follow_set(target_human_id, following)', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(
      RPC.followSet,
      fixtures.relationshipChange({ isFollowing: true, friendRequest: 'none' }),
    )
    expect((await client.social.setFollow(MAYA, true)).isFollowing).toBe(true)
    expect(supabase.lastRpc()).toEqual({
      name: 'follow_set',
      args: { target_human_id: IDS.maya, following: true },
    })
    await client.social.setFollow(MAYA, false)
    expect(supabase.lastRpc().args).toEqual({ target_human_id: IDS.maya, following: false })
  })

  it('friend requests surface blocked', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcError(RPC.friendRequestSend, postgrestRaise('blocked'))
    expect((await earthRejection(client.social.friendRequest(MAYA))).code).toBe('blocked')
  })

  it('block / unblock map to block_set and blocks lists', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.blockSet, fixtures.blockChange())
    expect((await client.social.block(MAYA)).isBlocked).toBe(true)
    expect(supabase.lastRpc()).toEqual({
      name: 'block_set',
      args: { target_human_id: IDS.maya, blocked: true },
    })
    supabase.rpcData(RPC.blockSet, fixtures.blockChange({ isBlocked: false }))
    expect((await client.social.unblock(MAYA)).isBlocked).toBe(false)
    expect(supabase.lastRpc().args).toEqual({ target_human_id: IDS.maya, blocked: false })
    supabase.rpcData(RPC.blocksList, fixtures.blocksList())
    expect((await client.social.blocks()).blocks[0]?.blockedHumanId).toBe(IDS.kavon)
    supabase.rpcData(RPC.blocksList, fixtures.blocksList().blocks)
    expect((await client.social.blocks()).blocks).toHaveLength(1)
  })

  it('validates human ids before calling', async () => {
    const { client, supabase } = createTestClient()
    expect((await earthRejection(client.social.friendRequest('nope' as never))).code).toBe(
      'invalid_input',
    )
    expect(supabase.rpcCalls).toHaveLength(0)
  })
})

describe('safety', () => {
  it('report maps to report_create and validates the reason', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.reportCreate, fixtures.reportDto())
    const report = await client.safety.report({
      targetType: 'post',
      targetId: IDS.post,
      reason: 'spam_scam',
      details: null,
    })
    expect(supabase.lastRpc()).toEqual({
      name: 'report_create',
      args: { target_type: 'post', target_id: IDS.post, reason: 'spam_scam', details: null },
    })
    expect(report.status).toBe('open')
    expect(
      (
        await earthRejection(
          client.safety.report({
            targetType: 'post',
            targetId: IDS.post,
            reason: 'meh' as never,
            details: null,
          }),
        )
      ).code,
    ).toBe('invalid_input')
  })

  it('myReports accepts arrays or wrapped lists', async () => {
    const { client, supabase } = createTestClient()
    supabase.rpcData(RPC.reportsMine, [fixtures.reportDto()])
    expect(await client.safety.myReports()).toHaveLength(1)
    supabase.rpcData(RPC.reportsMine, {
      reports: [fixtures.reportDto(), fixtures.reportDto({ status: 'resolved' })],
    })
    expect(await client.safety.myReports()).toHaveLength(2)
    expect(supabase.lastRpc()).toEqual({ name: 'reports_mine', args: {} })
  })
})
