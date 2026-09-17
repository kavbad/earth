import { AUDIENCE, ROLE_KINDS } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { canViewPost, canViewPostInFeed, effectivePostAudience } from './post'
import { DEFAULT_PERMISSION_FLAGS, type PostVisibilityInput, type Viewer } from './types'

const active = (audience: PostVisibilityInput['audience']): PostVisibilityInput => ({
  audience,
  status: 'active',
  isReply: false,
})
const human = (extra: Partial<Viewer> = {}): Viewer => ({
  kind: 'human',
  relationToAuthor: 'other',
  blockedEitherWay: false,
  ...extra,
})

describe('canViewPost (mirror of earth.can_view_post)', () => {
  it('the author always sees their own post, even removed', () => {
    expect(
      canViewPost(human({ relationToAuthor: 'self' }), { ...active('friends'), status: 'removed' }),
    ).toBe(true)
  })

  it('removed posts are invisible to everyone else', () => {
    for (const audience of AUDIENCE) {
      expect(
        canViewPost(human({ relationToAuthor: 'friend' }), {
          ...active(audience),
          status: 'removed',
        }),
      ).toBe(false)
      expect(
        canViewPost(
          { kind: 'visitor', blockedEitherWay: false },
          { ...active(audience), status: 'removed' },
        ),
      ).toBe(false)
    }
  })

  it('blocks override every audience for every caller kind (spec §128)', () => {
    for (const kind of ROLE_KINDS) {
      if (kind === 'service') continue
      for (const audience of AUDIENCE) {
        expect(
          canViewPost(
            {
              kind,
              relationToAuthor: 'friend',
              blockedEitherWay: true,
              sameNeighborhood: true,
              sameCity: true,
            },
            active(audience),
          ),
          `${kind} ${audience}`,
        ).toBe(false)
      }
    }
  })

  it('friends of the author see every audience; strangers see by area or world', () => {
    for (const audience of AUDIENCE) {
      expect(canViewPost(human({ relationToAuthor: 'friend' }), active(audience))).toBe(true)
    }
    expect(canViewPost(human(), active('friends'))).toBe(false)
    expect(canViewPost(human(), active('neighborhood'))).toBe(false)
    expect(canViewPost(human({ sameCity: true }), active('neighborhood'))).toBe(false)
    expect(
      canViewPost(human({ sameNeighborhood: true, sameCity: true }), active('neighborhood')),
    ).toBe(true)
    expect(canViewPost(human(), active('city'))).toBe(false)
    expect(canViewPost(human({ sameCity: true }), active('city'))).toBe(true)
    expect(canViewPost(human({ sameNeighborhood: true }), active('city'))).toBe(true)
    expect(canViewPost(human(), active('world'))).toBe(true)
  })

  it('group membership, follow and familiarity are not friendship (spec §128)', () => {
    for (const relation of ['shared_group', 'familiar', 'other'] as const) {
      expect(
        canViewPost(human({ relationToAuthor: relation, sharedGroups: 3 }), active('friends')),
      ).toBe(false)
    }
  })

  it('visitors, guests and claiming Humans see World only, while PUBLIC_WORLD_ENABLED', () => {
    for (const kind of ['visitor', 'guest', 'claiming'] as const) {
      const viewer: Viewer = { kind, blockedEitherWay: false }
      expect(canViewPost(viewer, active('world'))).toBe(true)
      expect(
        canViewPost(viewer, active('world'), {
          ...DEFAULT_PERMISSION_FLAGS,
          publicWorldEnabled: false,
        }),
      ).toBe(false)
      for (const audience of ['friends', 'neighborhood', 'city'] as const) {
        expect(
          canViewPost({ ...viewer, sameNeighborhood: true, sameCity: true }, active(audience)),
        ).toBe(false)
      }
    }
    // Signed-in Humans keep World when the public flag is off.
    expect(
      canViewPost(human(), active('world'), {
        ...DEFAULT_PERMISSION_FLAGS,
        publicWorldEnabled: false,
      }),
    ).toBe(true)
  })

  it('replies are gated by the root audience (spec §72) and fall back to their own audience', () => {
    const reply: PostVisibilityInput = {
      audience: 'friends',
      status: 'active',
      isReply: true,
      rootAudience: 'world',
    }
    expect(effectivePostAudience(reply)).toBe('world')
    expect(canViewPost(human(), reply)).toBe(true)
    expect(canViewPost({ kind: 'visitor', blockedEitherWay: false }, reply)).toBe(true)
    const narrowRoot: PostVisibilityInput = {
      audience: 'world',
      status: 'active',
      isReply: true,
      rootAudience: 'friends',
    }
    expect(canViewPost(human(), narrowRoot)).toBe(false)
    const unknownRoot: PostVisibilityInput = {
      audience: 'friends',
      status: 'active',
      isReply: true,
    }
    expect(effectivePostAudience(unknownRoot)).toBe('friends')
    expect(canViewPost(human(), unknownRoot)).toBe(false)
  })

  it('hides exclude from feeds, never from a direct fetch (DB_API §4)', () => {
    const hidden: PostVisibilityInput = { ...active('world'), hiddenByViewer: true }
    expect(canViewPost(human(), hidden)).toBe(true)
    expect(canViewPostInFeed(human(), hidden)).toBe(false)
    expect(canViewPostInFeed(human(), active('world'))).toBe(true)
    expect(canViewPostInFeed(human(), { ...active('friends'), hiddenByViewer: false })).toBe(false)
    expect(canViewPostInFeed({ kind: 'service', blockedEitherWay: false }, hidden)).toBe(true)
  })

  it('the service reads everything', () => {
    expect(
      canViewPost(
        { kind: 'service', blockedEitherWay: false },
        { ...active('friends'), status: 'removed' },
      ),
    ).toBe(true)
  })
})
