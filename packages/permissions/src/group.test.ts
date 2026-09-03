import { describe, expect, it } from 'vitest'

import { canPreviewInviteMember } from './group'
import type { Viewer } from './types'

const human = (extra: Partial<Viewer> = {}): Viewer => ({
  kind: 'human',
  relationToAuthor: 'other',
  blockedEitherWay: false,
  ...extra,
})

describe('canPreviewInviteMember (mirror of group_invite_preview sample members)', () => {
  it('public members are previewed to anyone; limited and hidden only to friends of a Human viewer', () => {
    for (const kind of ['visitor', 'guest', 'claiming'] as const) {
      const viewer: Viewer = { kind, blockedEitherWay: false }
      expect(
        canPreviewInviteMember(viewer, { profileVisibility: 'public', isFriendOfViewer: false }),
      ).toBe(true)
      expect(
        canPreviewInviteMember(viewer, { profileVisibility: 'limited', isFriendOfViewer: false }),
      ).toBe(false)
      expect(
        canPreviewInviteMember(viewer, { profileVisibility: 'hidden', isFriendOfViewer: false }),
      ).toBe(false)
      // A visitor has no friends; the flag cannot promote them.
      expect(
        canPreviewInviteMember(viewer, { profileVisibility: 'limited', isFriendOfViewer: true }),
      ).toBe(false)
    }
    expect(
      canPreviewInviteMember(human(), { profileVisibility: 'limited', isFriendOfViewer: false }),
    ).toBe(false)
    expect(
      canPreviewInviteMember(human(), { profileVisibility: 'limited', isFriendOfViewer: true }),
    ).toBe(true)
    expect(
      canPreviewInviteMember(human({ relationToAuthor: 'friend' }), {
        profileVisibility: 'hidden',
        isFriendOfViewer: false,
      }),
    ).toBe(true)
    expect(
      canPreviewInviteMember(human({ relationToAuthor: 'shared_group', sharedGroups: 1 }), {
        profileVisibility: 'hidden',
        isFriendOfViewer: false,
      }),
    ).toBe(false)
  })

  it('never the viewer, never across a block, never an inactive Human', () => {
    expect(
      canPreviewInviteMember(human({ relationToAuthor: 'self' }), {
        profileVisibility: 'public',
        isFriendOfViewer: false,
      }),
    ).toBe(false)
    expect(
      canPreviewInviteMember(human({ blockedEitherWay: true }), {
        profileVisibility: 'public',
        isFriendOfViewer: true,
      }),
    ).toBe(false)
    expect(
      canPreviewInviteMember(human(), {
        profileVisibility: 'public',
        isFriendOfViewer: false,
        humanStatus: 'pending',
      }),
    ).toBe(false)
    expect(
      canPreviewInviteMember(human(), {
        profileVisibility: 'public',
        isFriendOfViewer: false,
        humanStatus: 'active',
      }),
    ).toBe(true)
  })
})
