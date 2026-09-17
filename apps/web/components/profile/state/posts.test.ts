import { fixtures } from '@earth/api/testing'
import { PublicIdentityDtoSchema, asHumanId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import { ProfilePostRowsSchema, needsDetail, postViewFromRow, selectProfilePosts } from './posts'

const author = PublicIdentityDtoSchema.parse(fixtures.identity())
const XAVIER = asHumanId(fixtures.IDS.xavier)

const rows = ProfilePostRowsSchema.parse([
  {
    id: fixtures.IDS.post,
    author_human_id: fixtures.IDS.xavier,
    type: 'image',
    text: null,
    audience: 'world',
    area_id: null,
    place_id: null,
    reply_policy: 'everyone_eligible',
    reshare_policy: 'allowed_within_audience',
    parent_post_id: null,
    root_post_id: null,
    created_at: '2026-09-03T06:00:00+00:00',
    edited_at: null,
    deleted_at: null,
    reaction_count: 2,
    reply_count: 0,
  },
  {
    id: fixtures.IDS.reply,
    author_human_id: fixtures.IDS.xavier,
    type: 'text',
    text: 'a reply',
    audience: 'friends',
    area_id: null,
    place_id: null,
    parent_post_id: fixtures.IDS.post,
    root_post_id: fixtures.IDS.post,
    created_at: '2026-09-03T07:00:00+00:00',
  },
  {
    id: fixtures.IDS.message,
    author_human_id: fixtures.IDS.xavier,
    type: 'text',
    text: 'newest',
    audience: 'friends',
    area_id: null,
    place_id: null,
    parent_post_id: null,
    root_post_id: null,
    created_at: '2026-09-03T08:00:00+00:00',
  },
])

describe('profile posts (SCREEN 22)', () => {
  it('keeps top-level posts by the Human, newest first', () => {
    expect(selectProfilePosts(rows, XAVIER).map((row) => row.text)).toEqual(['newest', null])
    expect(selectProfilePosts(rows, XAVIER, 1)).toHaveLength(1)
    expect(selectProfilePosts(rows, asHumanId(fixtures.IDS.maya))).toEqual([])
  })

  it('shapes a row into a post view and knows when media must be fetched', () => {
    const view = postViewFromRow(rows[0]!, author)
    expect(view.post.id).toBe(fixtures.IDS.post)
    expect(view.author.displayName).toBe(author.displayName)
    expect(view.reactionCount).toBe(2)
    expect(view.media).toEqual([])
    expect(needsDetail(view)).toBe(true)
    expect(needsDetail(postViewFromRow(rows[2]!, author))).toBe(false)
  })
})
