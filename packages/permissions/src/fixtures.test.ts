/**
 * Fixture-driven mirror test (DB_API §11): every case of `fixtures/*.json` must get the same
 * answer from `canViewObject` (and from `canJoinRoom` / `canSendMessage` for the probes) that the
 * database gives in `supabase/tests/src/authz/permissions-fixtures.test.ts`.
 */
import {
  AUDIENCE,
  HUMAN_STATUS,
  PROFILE_VISIBILITY,
  ROLE_KINDS,
  ROOM_JOIN_POLICY,
  ROOM_VISIBILITY,
  VIEWER_RELATIONS,
} from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { canSendMessage } from './conversation'
import {
  FIXTURES_DIR,
  fixturePath,
  loadAllFixtures,
  loadFixtureFile,
  parseFixtureFile,
  resolveFixtureCase,
  type ResolvedFixtureCase,
} from './fixtures'
import { canViewObject } from './index'
import { canJoinRoom } from './room'
import { RoomJoinInputSchema, VIEWABLE_OBJECT_TYPES } from './types'

const fixtures = loadAllFixtures()

function byObject(object: (typeof VIEWABLE_OBJECT_TYPES)[number]): readonly ResolvedFixtureCase[] {
  const entry = fixtures.find((f) => f.object === object)
  if (entry === undefined) throw new Error(`missing fixture ${object}`)
  return entry.cases
}

describe('fixture files', () => {
  it('exist for every object type, in the DB_API §11 format, with unique case names', () => {
    expect(fixtures.map((f) => f.object)).toEqual([...VIEWABLE_OBJECT_TYPES])
    for (const { object, file } of fixtures) {
      expect(fixturePath(object)).toBe(`${FIXTURES_DIR}${object}.json`)
      expect(file.object).toBe(object)
      expect(file.cases.length).toBeGreaterThan(0)
      const names = file.cases.map((c) => c.name)
      expect(new Set(names).size, `${object}: duplicate case names`).toBe(names.length)
    }
  })

  it('reject a case whose object does not match the file object', () => {
    expect(() =>
      parseFixtureFile(
        JSON.stringify({
          object: 'post',
          cases: [
            {
              name: 'x',
              viewer: { kind: 'human', blockedEitherWay: false },
              object: {},
              expect: true,
            },
          ],
        }),
      ),
    ).not.toThrow()
    const file = loadFixtureFile('post')
    expect(() =>
      resolveFixtureCase(file, {
        name: 'bad',
        viewer: { kind: 'human', blockedEitherWay: false },
        object: { audience: 'galaxy', status: 'active', isReply: false },
        expect: true,
      }),
    ).toThrow()
  })
})

describe('canViewObject agrees with every fixture case', () => {
  for (const { object, cases } of fixtures) {
    describe(object, () => {
      for (const c of cases) {
        it(c.name, () => {
          expect(canViewObject({ viewer: c.viewer, object: c.object, flags: c.flags })).toBe(
            c.expect,
          )
        })
      }
    })
  }
})

describe('room join probes agree with canJoinRoom', () => {
  for (const c of byObject('room')) {
    if (c.join === undefined) continue
    it(c.name, () => {
      const room = RoomJoinInputSchema.parse(c.object)
      const decision = canJoinRoom(
        c.viewer,
        room,
        { mediaState: c.join!.mediaState, consentLevel: c.join!.consentLevel },
        c.flags,
      )
      expect(decision.allowed).toBe(c.join!.expect)
      expect(decision.reason ?? null).toBe(c.join!.reason)
      expect(decision.requiresApproval ?? false).toBe(c.join!.requiresApproval ?? false)
    })
  }
})

describe('conversation send probes agree with canSendMessage', () => {
  for (const c of byObject('conversation')) {
    if (c.send === undefined) continue
    it(c.name, () => {
      if (c.object.type !== 'conversation') throw new Error('not a conversation case')
      const decision = canSendMessage(c.viewer, c.object)
      expect(decision.allowed).toBe(c.send!.expect)
      expect(decision.reason ?? null).toBe(c.send!.reason)
    })
  }
})

describe('matrices are exhaustive', () => {
  const KINDS = ROLE_KINDS.filter((kind) => kind !== 'service')

  it('post: every audience × relation × block × area context for Humans, every audience × status × kind', () => {
    const cases = byObject('post')
    for (const audience of AUDIENCE) {
      for (const status of ['active', 'removed'] as const) {
        for (const kind of KINDS) {
          expect(
            cases.some(
              (c) =>
                c.viewer.kind === kind &&
                c.object.type === 'post' &&
                c.object.audience === audience &&
                c.object.status === status,
            ),
            `${kind} ${audience} ${status}`,
          ).toBe(true)
        }
      }
      for (const relation of VIEWER_RELATIONS) {
        for (const blocked of [false, true]) {
          if (relation === 'self' && blocked) continue
          for (const [sameNeighborhood, sameCity] of [
            [false, false],
            [false, true],
            [true, true],
          ]) {
            expect(
              cases.some(
                (c) =>
                  c.viewer.kind === 'human' &&
                  c.viewer.relationToAuthor === relation &&
                  c.viewer.blockedEitherWay === blocked &&
                  (c.viewer.sameNeighborhood ?? false) === sameNeighborhood &&
                  (c.viewer.sameCity ?? false) === sameCity &&
                  c.object.type === 'post' &&
                  c.object.audience === audience &&
                  !c.object.isReply,
              ),
              `${relation} blocked=${blocked} n=${sameNeighborhood} c=${sameCity} ${audience}`,
            ).toBe(true)
          }
        }
      }
      // Replies in threads of every root audience, for every reply audience within it.
      for (const rootAudience of AUDIENCE) {
        if (AUDIENCE.indexOf(audience) > AUDIENCE.indexOf(rootAudience)) continue
        expect(
          cases.some(
            (c) =>
              c.object.type === 'post' &&
              c.object.isReply &&
              c.object.audience === audience &&
              c.object.rootAudience === rootAudience,
          ),
          `reply ${audience} in ${rootAudience}`,
        ).toBe(true)
      }
    }
  })

  it('room: every visibility × join policy for every Human relation profile, every visibility × kind, media × consent', () => {
    const cases = byObject('room')
    const humanProfiles = new Set(
      cases.filter((c) => c.viewer.kind === 'human').map((c) => JSON.stringify(c.viewer)),
    )
    expect(humanProfiles.size).toBeGreaterThanOrEqual(11)
    for (const visibility of ROOM_VISIBILITY) {
      for (const kind of KINDS) {
        expect(
          cases.some(
            (c) =>
              c.viewer.kind === kind &&
              c.object.type === 'room' &&
              c.object.visibility === visibility,
          ),
          `${kind} ${visibility}`,
        ).toBe(true)
      }
      for (const profile of humanProfiles) {
        for (const joinPolicy of ROOM_JOIN_POLICY) {
          expect(
            cases.some(
              (c) =>
                JSON.stringify(c.viewer) === profile &&
                c.object.type === 'room' &&
                c.object.visibility === visibility &&
                c.object.joinPolicy === joinPolicy &&
                c.join?.mediaState === 'camera',
            ),
            `${profile} ${visibility} ${joinPolicy}`,
          ).toBe(true)
        }
        expect(
          cases.some(
            (c) =>
              JSON.stringify(c.viewer) === profile &&
              c.object.type === 'room' &&
              c.object.visibility === visibility &&
              c.join?.mediaState === 'watching',
          ),
          `${profile} ${visibility} watching`,
        ).toBe(true)
      }
    }
    // Consent below the room's visibility is probed, and so are blocked viewers, guests disabled, ended rooms.
    expect(cases.some((c) => c.join?.reason === 'consent_required')).toBe(true)
    expect(cases.some((c) => c.viewer.blockedEitherWay && c.viewer.kind === 'human')).toBe(true)
    expect(cases.some((c) => c.object.type === 'room' && c.object.guestsDisabled)).toBe(true)
    expect(cases.some((c) => c.object.type === 'room' && c.object.status === 'ended')).toBe(true)
    expect(cases.some((c) => c.join?.requiresApproval === true)).toBe(true)
  })

  it('profile: every visibility × relation × block × status for Humans, every visibility × status × kind', () => {
    const cases = byObject('profile')
    for (const profileVisibility of PROFILE_VISIBILITY) {
      for (const humanStatus of HUMAN_STATUS) {
        for (const kind of KINDS) {
          expect(
            cases.some(
              (c) =>
                c.viewer.kind === kind &&
                c.object.type === 'profile' &&
                c.object.profileVisibility === profileVisibility &&
                c.object.humanStatus === humanStatus,
            ),
            `${kind} ${profileVisibility} ${humanStatus}`,
          ).toBe(true)
        }
        for (const relation of VIEWER_RELATIONS) {
          for (const blocked of [false, true]) {
            if (relation === 'self' && blocked) continue
            expect(
              cases.some(
                (c) =>
                  c.viewer.kind === 'human' &&
                  c.viewer.relationToAuthor === relation &&
                  c.viewer.blockedEitherWay === blocked &&
                  c.object.type === 'profile' &&
                  c.object.profileVisibility === profileVisibility &&
                  c.object.humanStatus === humanStatus,
              ),
              `${relation} blocked=${blocked} ${profileVisibility} ${humanStatus}`,
            ).toBe(true)
          }
        }
      }
    }
  })

  it('conversation: type × membership × block for Humans, type × kind', () => {
    const cases = byObject('conversation')
    for (const conversationType of ['direct', 'group'] as const) {
      for (const kind of KINDS) {
        expect(
          cases.some(
            (c) =>
              c.viewer.kind === kind &&
              c.object.type === 'conversation' &&
              c.object.conversationType === conversationType,
          ),
        ).toBe(true)
      }
      for (const member of [false, true]) {
        for (const blocked of [false, true]) {
          expect(
            cases.some(
              (c) =>
                c.viewer.kind === 'human' &&
                (c.viewer.isConversationMember ?? false) === member &&
                c.viewer.blockedEitherWay === blocked &&
                c.object.type === 'conversation' &&
                c.object.conversationType === conversationType &&
                c.send !== undefined,
            ),
          ).toBe(true)
        }
      }
    }
  })

  it('group_invite_preview: visibility × friendship × block for Humans, visibility × kind', () => {
    const cases = byObject('group_invite_preview')
    for (const profileVisibility of PROFILE_VISIBILITY) {
      for (const kind of KINDS) {
        expect(
          cases.some(
            (c) =>
              c.viewer.kind === kind &&
              c.object.type === 'group_invite_preview' &&
              c.object.profileVisibility === profileVisibility,
          ),
        ).toBe(true)
      }
      for (const isFriendOfViewer of [false, true]) {
        for (const blocked of [false, true]) {
          expect(
            cases.some(
              (c) =>
                c.viewer.kind === 'human' &&
                c.viewer.blockedEitherWay === blocked &&
                c.object.type === 'group_invite_preview' &&
                c.object.profileVisibility === profileVisibility &&
                c.object.isFriendOfViewer === isFriendOfViewer,
            ),
          ).toBe(true)
        }
      }
    }
  })
})
