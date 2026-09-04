import { FEATURE_FLAG_DEFAULTS, FeatureFlag, type FeatureFlags } from '@earth/config'
import type { RoomInvitePreviewDto } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  type InvitePreview,
  inviteActions,
  invitePreviewHost,
  invitePreviewMeta,
  invitePreviewTitle,
  mediaStateForAction,
} from './invite'

const flags = (overrides: Partial<FeatureFlags> = {}): FeatureFlags => ({
  ...FEATURE_FLAG_DEFAULTS,
  ...overrides,
})

function participant(displayName: string): RoomInvitePreviewDto['participants'][number] {
  return { displayName, avatarUrl: null, isGuest: false }
}

function preview(overrides: Partial<InvitePreview> = {}): InvitePreview {
  return {
    ended: false,
    guestsAllowed: true,
    participants: [participant('Xavier'), participant('Kavon')],
    contextTitle: null,
    invitedByDisplayName: 'Maya',
    joinPolicy: 'friends',
    ...overrides,
  }
}

describe('inviteActions (SCREEN 17 in the app; spec §112)', () => {
  it('lets a Human join on camera, on audio, or just watch', () => {
    expect(inviteActions({ preview: preview(), roleKind: 'human', flags: flags() })).toEqual([
      'join_camera',
      'join_audio',
      'watch',
    ])
  })

  it('sends a Visitor to the web Guest page and to the claim flow', () => {
    expect(inviteActions({ preview: preview(), roleKind: 'visitor', flags: flags() })).toEqual([
      'guest_web',
      'claim',
    ])
  })

  it('offers only the claim when the room takes no Guests or the flag is off', () => {
    expect(
      inviteActions({
        preview: preview({ guestsAllowed: false }),
        roleKind: 'visitor',
        flags: flags(),
      }),
    ).toEqual(['claim'])
    expect(
      inviteActions({
        preview: preview(),
        roleKind: 'visitor',
        flags: flags({ [FeatureFlag.GUEST_ROOMS_ENABLED]: false }),
      }),
    ).toEqual(['claim'])
  })

  it('offers nothing once the room has ended', () => {
    expect(
      inviteActions({ preview: preview({ ended: true }), roleKind: 'human', flags: flags() }),
    ).toEqual([])
  })

  it('maps join actions to media states', () => {
    expect(mediaStateForAction('join_camera')).toBe('camera')
    expect(mediaStateForAction('join_audio')).toBe('audio')
    expect(mediaStateForAction('watch')).toBe('watching')
    expect(mediaStateForAction('claim')).toBeNull()
    expect(mediaStateForAction('guest_web')).toBeNull()
  })
})

describe('invite preview copy', () => {
  it('names the group or the people, viewer-aware (spec §60)', () => {
    expect(invitePreviewTitle(preview({ contextTitle: 'Weekend Crew' }))).toBe(
      'Weekend Crew is live',
    )
    expect(invitePreviewTitle(preview())).toBe('Xavier + Kavon are live')
    expect(invitePreviewTitle(preview({ participants: [] }))).toBe('Live')
  })

  it('says who shared the link and who can join', () => {
    expect(invitePreviewMeta(preview())).toBe('Shared by Maya · Who can join: Friends')
    expect(invitePreviewMeta(preview({ invitedByDisplayName: null }))).toBe('Who can join: Friends')
  })

  it('opens SCREEN 16 with the sharer, else the first face', () => {
    expect(invitePreviewHost(preview())).toBe('Maya')
    expect(invitePreviewHost(preview({ invitedByDisplayName: null }))).toBe('Xavier')
    expect(invitePreviewHost(preview({ invitedByDisplayName: null, participants: [] }))).toBeNull()
  })
})
