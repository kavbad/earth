/**
 * SCREEN 14 participants sheet: spec §81 gives every Human profile and every Guest a Report, and
 * keeps Remove / block-from-this-room with the moderator. The report target is the person, not the
 * room: `report_create(target_type = 'human')` for a Human, `'guest'` with the guest session id
 * for a Guest (DB_API §7).
 */
import type { RoomParticipantDto } from '@earth/domain'
import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { roomCopy } from '@/features/rooms/copy'
import { render } from '@/test/render'

import {
  ParticipantsSheet,
  type ParticipantsSheetProps,
  reportPersonTitle,
  reportTargetForParticipant,
} from './ParticipantsSheet'

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
const base: ParticipantsSheetProps = {
  open: true,
  participants: [me, participant(), guest],
  meId: 'me-row',
  canModerate: false,
  onRemove: noop,
  onAdmit: noop,
  onReport: noop,
  onClose: noop,
}

describe('reportTargetForParticipant (spec §81, DB_API §7)', () => {
  it('reports a Human by humanId and a Guest by guest session id', () => {
    expect(reportTargetForParticipant(participant())).toEqual({ type: 'human', id: THEM })
    expect(reportTargetForParticipant(guest)).toEqual({ type: 'guest', id: GUEST_SESSION })
  })

  it('offers nothing for a row that identifies nobody', () => {
    expect(
      reportTargetForParticipant(participant({ humanId: null, guestSessionId: null })),
    ).toBeNull()
    expect(reportPersonTitle('Sam')).toBe(`${copy.safety.report} Sam`)
  })
})

describe('ParticipantsSheet (spec §81)', () => {
  it('gives a plain participant Report for the Human and for the Guest, and nothing else', () => {
    const reported: string[] = []
    const screen = render(
      <ParticipantsSheet {...base} onReport={(p) => reported.push(p.displayName)} />,
    )
    expect(screen.byLabel(`${copy.safety.report}: Maya`)).toHaveLength(1)
    expect(screen.byLabel(`${copy.safety.report}: Sam`)).toHaveLength(1)
    expect(screen.byLabel(`${copy.safety.report}: You`)).toHaveLength(0)
    expect(screen.text()).not.toContain(copy.safety.remove)
    expect(screen.byLabel(`${roomCopy.blockFromRoom}: Sam`)).toHaveLength(0)

    screen.press(`${copy.safety.report}: Sam`)
    screen.press(`${copy.safety.report}: Maya`)
    expect(reported).toEqual(['Sam', 'Maya'])
  })

  it('hands the reporter the target report_create needs', () => {
    const targets: unknown[] = []
    const screen = render(
      <ParticipantsSheet {...base} onReport={(p) => targets.push(reportTargetForParticipant(p))} />,
    )
    screen.press(`${copy.safety.report}: Maya`)
    screen.press(`${copy.safety.report}: Sam`)
    expect(targets).toEqual([
      { type: 'human', id: THEM },
      { type: 'guest', id: GUEST_SESSION },
    ])
  })

  it('keeps the moderator’s Remove and block-from-room alongside Report', () => {
    const removed: Array<[string, boolean]> = []
    const screen = render(
      <ParticipantsSheet
        {...base}
        canModerate
        onRemove={(p, block) => removed.push([p.displayName, block])}
      />,
    )
    expect(screen.byLabel(`${copy.safety.report}: Sam`)).toHaveLength(1)
    expect(screen.byLabel(`${roomCopy.blockFromRoom}: Sam`)).toHaveLength(1)
    expect(screen.text()).toContain(copy.safety.remove)

    screen.press(`${roomCopy.blockFromRoom}: Sam`)
    expect(removed).toEqual([['Sam', true]])
  })

  it('lets a moderator report someone waiting to be admitted', () => {
    const waiting = participant({ id: 'waiting-row', displayName: 'Alex', status: 'waiting' })
    const screen = render(<ParticipantsSheet {...base} canModerate participants={[me, waiting]} />)
    expect(screen.text()).toContain(roomCopy.admit)
    expect(screen.byLabel(`${copy.safety.report}: Alex`)).toHaveLength(1)
  })
})
