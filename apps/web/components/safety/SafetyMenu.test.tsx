/**
 * Spec §81 controls per target and §82 reasons, rendered without providers.
 */
import { REPORT_REASON, asGuestSessionId, asHumanId, asPostId, asRoomId } from '@earth/domain'
import { copy } from '@earth/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BlockConfirmView } from './BlockConfirm'
import { ReportSheetView } from './ReportSheet'
import { SafetyMenuView, claimEntryFor, reportTargetFor, safetyActionsFor } from './SafetyMenu'
import { safetyCopy } from './copy'

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

  it('reports the right target type and routes visitors to the matching claim entry', () => {
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
  })
})

describe('sheets', () => {
  it('ReportSheet lists the eleven §82 reasons in the spec order', () => {
    const html = renderToStaticMarkup(
      <ReportSheetView open onReason={() => undefined} onClose={() => undefined} />,
    )
    const positions = REPORT_REASON.map((reason) => html.indexOf(`>${copy.reportReasons[reason]}<`))
    expect(positions.every((index) => index >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(html).toContain('Dangerous location/stalking behavior')
    expect(html).toContain('Exploitation/minor safety')
  })

  it('ReportSheet confirms quietly once done', () => {
    const html = renderToStaticMarkup(
      <ReportSheetView open done onReason={() => undefined} onClose={() => undefined} />,
    )
    expect(html).toContain(safetyCopy.reportSent)
    expect(html).not.toContain('Harassment')
  })

  it('BlockConfirm explains group coexistence (spec §56)', () => {
    const html = renderToStaticMarkup(
      <BlockConfirmView
        open
        displayName="Maya"
        onConfirm={() => undefined}
        onClose={() => undefined}
      />,
    )
    expect(html).toContain('Block Maya?')
    expect(html).toContain('you both stay in it')
    expect(html).toContain(`<span>${copy.safety.block}</span>`)
    expect(html).toContain(`<span>${copy.notNow}</span>`)
  })

  it('SafetyMenuView renders the given actions with destructive ones in danger', () => {
    const html = renderToStaticMarkup(
      <SafetyMenuView
        open
        actions={safetyActionsFor({
          kind: 'post',
          postId: POST,
          authorHumanId: HUMAN,
          authorDisplayName: 'Maya',
        })}
        onAction={() => undefined}
        onClose={() => undefined}
      />,
    )
    expect(html).toContain(copy.safety.hide)
    expect(html).toContain(`class="text-danger">${copy.safety.blockAuthor}`)
  })
})
