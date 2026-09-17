import { REPORT_REASON, asGuestSessionId, asHumanId, asPostId, asRoomId } from '@earth/domain'
import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import {
  BlocksWithIdentitySchema,
  ReportsWithDetailSchema,
  blockableFor,
  blockedName,
  claimEntryFor,
  reportTargetFor,
  safetyActionAllowed,
  safetyActionsFor,
  withoutBlocked,
} from './safety'

const HUMAN = asHumanId('11111111-1111-4111-8111-111111111111')
const POST = asPostId('55555555-5555-4555-8555-555555555555')
const ROOM = asRoomId('77777777-7777-4777-8777-777777777777')
const GUEST = asGuestSessionId('99999999-9999-4999-8999-999999999999')

describe('safetyActionsFor (spec §81)', () => {
  it('every post: Report, Hide, Block author', () => {
    const keys = safetyActionsFor({
      kind: 'post',
      postId: POST,
      authorHumanId: HUMAN,
      authorDisplayName: 'Maya',
    })
    expect(keys.map((a) => a.label)).toEqual([
      copy.safety.report,
      copy.safety.hide,
      copy.safety.blockAuthor,
    ])
    expect(
      safetyActionsFor({
        kind: 'post',
        postId: POST,
        authorHumanId: HUMAN,
        authorDisplayName: 'Me',
        isOwn: true,
      }),
    ).toEqual([])
  })

  it('every Human profile: Block (or Unblock), Report', () => {
    expect(
      safetyActionsFor({
        kind: 'profile',
        humanId: HUMAN,
        displayName: 'Maya',
        isBlocked: false,
      }).map((a) => a.key),
    ).toEqual(['block', 'report'])
    expect(
      safetyActionsFor({
        kind: 'profile',
        humanId: HUMAN,
        displayName: 'Maya',
        isBlocked: true,
      }).map((a) => a.label),
    ).toEqual([copy.safety.unblock, copy.safety.report])
  })

  it('every room: Leave, Report — Report alone when not inside', () => {
    expect(
      safetyActionsFor({ kind: 'room', roomId: ROOM, title: 'Weekend Crew', canLeave: true }).map(
        (a) => a.label,
      ),
    ).toEqual([copy.safety.leave, copy.safety.report])
    expect(
      safetyActionsFor({ kind: 'room', roomId: ROOM, title: 'Weekend Crew', canLeave: false }).map(
        (a) => a.key,
      ),
    ).toEqual(['report'])
  })

  it('every Guest: Remove, block from room (moderators), Report (everyone)', () => {
    const guest = {
      kind: 'guest',
      roomId: ROOM,
      participantId: 'p1',
      guestSessionId: GUEST,
      displayName: 'Sam',
    } as const
    expect(safetyActionsFor({ ...guest, canModerate: true }).map((a) => a.key)).toEqual([
      'remove',
      'removeAndBlock',
      'report',
    ])
    expect(safetyActionsFor({ ...guest, canModerate: false }).map((a) => a.key)).toEqual(['report'])
  })

  it('reports the right target type, routes visitors to the matching claim entry, names the blockable', () => {
    expect(
      reportTargetFor({
        kind: 'post',
        postId: POST,
        authorHumanId: HUMAN,
        authorDisplayName: 'Maya',
      }),
    ).toEqual({ type: 'post', id: POST })
    expect(
      reportTargetFor({ kind: 'profile', humanId: HUMAN, displayName: 'Maya', isBlocked: false }),
    ).toEqual({ type: 'human', id: HUMAN })
    expect(reportTargetFor({ kind: 'room', roomId: ROOM, title: 't', canLeave: true })).toEqual({
      type: 'room',
      id: ROOM,
    })
    expect(claimEntryFor('post')).toBe('post')
    expect(claimEntryFor('profile')).toBe('profile')
    expect(claimEntryFor('earth')).toBe('public_world')
    expect(
      blockableFor({ kind: 'post', postId: POST, authorHumanId: HUMAN, authorDisplayName: 'Maya' }),
    ).toEqual({ humanId: HUMAN, displayName: 'Maya' })
    expect(blockableFor({ kind: 'room', roomId: ROOM, title: 't', canLeave: true })).toBeNull()
  })

  it('lets Humans act, Guests report their room, and sends everyone else to claim', () => {
    expect(safetyActionAllowed('human', 'block', 'profile')).toBe(true)
    expect(safetyActionAllowed('guest', 'report', 'room')).toBe(true)
    expect(safetyActionAllowed('guest', 'report', 'guest')).toBe(true)
    expect(safetyActionAllowed('guest', 'report', 'post')).toBe(false)
    expect(safetyActionAllowed('visitor', 'report', 'room')).toBe(false)
  })

  it('offers the eleven §82 reasons through the shared copy', () => {
    expect(REPORT_REASON).toHaveLength(11)
    expect(copy.reportReasons.dangerous_location_stalking).toBe(
      'Dangerous location/stalking behavior',
    )
    expect(copy.reportReasons.exploitation_minor_safety).toBe('Exploitation/minor safety')
  })
})

describe('Settings → Safety lists', () => {
  it('reads blocks with or without identities and either result shape', () => {
    const block = {
      blockerHumanId: HUMAN,
      blockedHumanId: '22222222-2222-4222-8222-222222222222',
      createdAt: '2026-09-03T18:00:00.000Z',
    }
    const bare = BlocksWithIdentitySchema.parse([block])
    expect(blockedName(bare.blocks[0]!)).toBe(copy.human)
    const keyed = BlocksWithIdentitySchema.parse({
      blocks: [{ ...block, identity: { humanId: block.blockedHumanId, displayName: 'Sam' } }],
    })
    expect(blockedName(keyed.blocks[0]!)).toBe('Sam')
    expect(withoutBlocked(keyed.blocks, block.blockedHumanId)).toEqual([])
  })

  it('reads report history with optional detail', () => {
    const parsed = ReportsWithDetailSchema.parse([
      {
        id: '33333333-3333-4333-8333-333333333333',
        status: 'open',
        createdAt: '2026-09-03T18:00:00.000Z',
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        status: 'resolved',
        createdAt: '2026-09-03T18:00:00.000Z',
        targetType: 'post',
        reason: 'spam_scam',
      },
    ])
    expect(parsed.reports).toHaveLength(2)
    expect(parsed.reports[1]!.reason).toBe('spam_scam')
  })
})
