/**
 * SCREEN 14 / 18 participants sheet: spec §81 gives every Human profile and every Guest a Report,
 * and keeps Remove / block-from-this-room with the moderator. The report target is the person, not
 * the room: `report_create(target_type = 'human')` for a Human, `'guest'` with the guest session id
 * for a Guest (DB_API §7).
 */
import type { RoomParticipantDto } from '@earth/domain'
import { copy } from '@earth/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ParticipantsSheet, reportTargetForParticipant } from './ParticipantsSheet'
import { roomCopy } from './copy'

const ME = '11111111-1111-4111-8111-111111111111' as RoomParticipantDto['humanId'] & string
const THEM = '22222222-2222-4222-8222-222222222222' as RoomParticipantDto['humanId'] & string
const GUEST_SESSION =
  '99999999-9999-4999-8999-999999999999' as RoomParticipantDto['guestSessionId'] & string

function participant(overrides: Partial<RoomParticipantDto> = {}): RoomParticipantDto {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    humanId: THEM,
    guestSessionId: null,
    displayName: 'Maya',
    avatarUrl: null,
    isGuest: false,
    role: 'participant',
    mediaState: 'camera',
    status: 'active',
    audienceConsentLevel: 'group',
    joinedAt: '2026-09-03T10:00:00.000Z',
    relationToViewer: 'friend',
    ...overrides,
  }
}

const me = participant({ id: 'me-row', humanId: ME, displayName: 'You' })
const guest = participant({
  id: 'guest-row',
  humanId: null,
  guestSessionId: GUEST_SESSION,
  isGuest: true,
  displayName: 'Sam',
})

const noop = () => undefined
const base = {
  open: true,
  participants: [me, participant(), guest],
  meId: 'me-row',
  canModerate: false,
  onRemove: noop,
  onAdmit: noop,
  onReport: noop,
  onClose: noop,
} as const

describe('reportTargetForParticipant (spec §81, DB_API §7)', () => {
  it('reports a Human by humanId and a Guest by guest session id', () => {
    expect(reportTargetForParticipant(participant())).toEqual({ type: 'human', id: THEM })
    expect(reportTargetForParticipant(guest)).toEqual({ type: 'guest', id: GUEST_SESSION })
  })

  it('offers nothing for a row that identifies nobody', () => {
    expect(
      reportTargetForParticipant(participant({ humanId: null, guestSessionId: null })),
    ).toBeNull()
    expect(
      reportTargetForParticipant(participant({ isGuest: true, guestSessionId: null })),
    ).toBeNull()
  })
})

describe('ParticipantsSheet (spec §81)', () => {
  it('gives a plain participant Report for the Human and for the Guest, and nothing else', () => {
    const html = renderToStaticMarkup(<ParticipantsSheet {...base} />)
    expect(html).toContain(`${copy.safety.report}: Maya`)
    expect(html).toContain(`${copy.safety.report}: Sam`)
    // Moderation stays with the moderator.
    expect(html).not.toContain(copy.safety.remove)
    expect(html).not.toContain(roomCopy.blockFromRoom)
  })

  it('never offers to report yourself', () => {
    const html = renderToStaticMarkup(<ParticipantsSheet {...base} />)
    expect(html).not.toContain(`${copy.safety.report}: You`)
  })

  it('keeps the moderator’s Remove and block-from-room alongside Report', () => {
    const html = renderToStaticMarkup(<ParticipantsSheet {...base} canModerate />)
    expect(html).toContain(copy.safety.remove)
    expect(html).toContain(`${roomCopy.blockFromRoom}: Sam`)
    expect(html).toContain(`${copy.safety.report}: Sam`)
    expect(html).toContain(`${copy.safety.report}: Maya`)
  })

  it('lets a moderator report someone waiting to be admitted', () => {
    const waiting = participant({ id: 'waiting-row', displayName: 'Alex', status: 'waiting' })
    const html = renderToStaticMarkup(
      <ParticipantsSheet {...base} canModerate participants={[me, waiting]} />,
    )
    expect(html).toContain(roomCopy.admit)
    expect(html).toContain(`${copy.safety.report}: Alex`)
  })
})
