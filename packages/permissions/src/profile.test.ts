import { HUMAN_STATUS, PROFILE_VISIBILITY } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { canViewProfile } from './profile'
import type { Viewer } from './types'

const human = (extra: Partial<Viewer> = {}): Viewer => ({
  kind: 'human',
  relationToAuthor: 'other',
  blockedEitherWay: false,
  ...extra,
})

describe('canViewProfile (mirror of earth.identity_visible_to)', () => {
  it('public → anyone, limited → signed-in Humans, hidden → friends', () => {
    const visitor: Viewer = { kind: 'visitor', blockedEitherWay: false }
    const guest: Viewer = { kind: 'guest', blockedEitherWay: false }
    const claiming: Viewer = { kind: 'claiming', blockedEitherWay: false }
    const stranger = human()
    const friend = human({ relationToAuthor: 'friend' })
    const groupMate = human({ relationToAuthor: 'shared_group', sharedGroups: 2 })
    const table: Record<(typeof PROFILE_VISIBILITY)[number], boolean[]> = {
      //       visitor guest claiming stranger friend groupMate
      public: [true, true, true, true, true, true],
      limited: [false, false, false, true, true, true],
      hidden: [false, false, false, false, true, false],
    }
    for (const profileVisibility of PROFILE_VISIBILITY) {
      const actual = [visitor, guest, claiming, stranger, friend, groupMate].map((viewer) =>
        canViewProfile(viewer, { profileVisibility, humanStatus: 'active' }),
      )
      expect(actual, profileVisibility).toEqual(table[profileVisibility])
    }
  })

  it('pending, restricted, suspended and deleted Humans are invisible (ARCHITECTURE §4)', () => {
    for (const humanStatus of HUMAN_STATUS) {
      if (humanStatus === 'active') continue
      expect(
        canViewProfile(human({ relationToAuthor: 'friend' }), {
          profileVisibility: 'public',
          humanStatus,
        }),
      ).toBe(false)
      expect(
        canViewProfile(
          { kind: 'visitor', blockedEitherWay: false },
          { profileVisibility: 'public', humanStatus },
        ),
      ).toBe(false)
    }
  })

  it('own row always, including a pending Human during the claim', () => {
    expect(
      canViewProfile(human({ relationToAuthor: 'self' }), {
        profileVisibility: 'hidden',
        humanStatus: 'active',
      }),
    ).toBe(true)
    expect(
      canViewProfile(
        { kind: 'claiming', relationToAuthor: 'self', blockedEitherWay: false },
        { profileVisibility: 'hidden', humanStatus: 'pending' },
      ),
    ).toBe(true)
    expect(
      canViewProfile(
        { kind: 'guest', relationToAuthor: 'self', blockedEitherWay: false },
        { profileVisibility: 'public', humanStatus: 'pending' },
      ),
    ).toBe(false)
  })

  it('never across a block; being blocked is never revealed as a distinct answer', () => {
    expect(
      canViewProfile(human({ relationToAuthor: 'friend', blockedEitherWay: true }), {
        profileVisibility: 'public',
        humanStatus: 'active',
      }),
    ).toBe(false)
    expect(
      canViewProfile(human({ blockedEitherWay: true }), {
        profileVisibility: 'public',
        humanStatus: 'active',
      }),
    ).toBe(
      canViewProfile(human({ blockedEitherWay: true }), {
        profileVisibility: 'hidden',
        humanStatus: 'active',
      }),
    )
  })

  it('the service reads everything', () => {
    expect(
      canViewProfile(
        { kind: 'service', blockedEitherWay: false },
        { profileVisibility: 'hidden', humanStatus: 'pending' },
      ),
    ).toBe(true)
  })
})
