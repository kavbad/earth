import { fixtures } from '@earth/api/testing'
import { MediaObjectDtoSchema } from '@earth/api'
import { asAreaId, asPlaceId } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  formatBytes,
  formatDuration,
  isPollVoteReaction,
  mediaPayload,
  messagePreviewText,
  messageTypeForFile,
  normalizeContentType,
  parseMediaPayload,
  parsePlacePayload,
  parsePollPayload,
  placePayload,
  pollOptionIdOf,
  pollPayload,
  pollVoteReaction,
} from './payloads'

describe('message previews (mirror of earth.message_preview)', () => {
  it('collapses whitespace, truncates, and names non-text types', () => {
    expect(messagePreviewText('text', '  Anyone   around\n tonight? ')).toBe(
      'Anyone around tonight?',
    )
    expect(messagePreviewText('text', 'x'.repeat(200))).toHaveLength(120)
    expect(messagePreviewText('image', null)).toBe('Photo')
    expect(messagePreviewText('video', '')).toBe('Video')
    expect(messagePreviewText('audio', null)).toBe('Voice message')
    expect(messagePreviewText('file', null)).toBe('File')
    expect(messagePreviewText('poll', null)).toBe('Poll')
    expect(messagePreviewText('place', null)).toBe('Place')
    expect(messagePreviewText('plan', null)).toBe('Plan')
    expect(messagePreviewText('system', null)).toBe('')
  })
})

describe('media payloads', () => {
  const media = MediaObjectDtoSchema.parse({
    id: fixtures.IDS.media,
    bucket: 'media',
    storageKey: `${fixtures.IDS.xavier}/abc.jpg`,
    contentType: 'image/jpeg',
    url: null,
  })

  it('round-trips through the schema with defaults for absent extras', () => {
    const payload = mediaPayload(media, { width: 1200, height: 800, byteSize: 1234 })
    expect(parseMediaPayload(payload)).toEqual({
      mediaObjectId: fixtures.IDS.media,
      bucket: 'media',
      storageKey: `${fixtures.IDS.xavier}/abc.jpg`,
      contentType: 'image/jpeg',
      width: 1200,
      height: 800,
      durationMs: null,
      byteSize: 1234,
      name: null,
    })
    expect(parseMediaPayload({})).toBeNull()
    expect(parseMediaPayload({ mediaObjectId: 'nope' })).toBeNull()
  })

  it('maps files to message types and cleans content types', () => {
    expect(messageTypeForFile('image/png')).toBe('image')
    expect(messageTypeForFile('video/mp4')).toBe('video')
    expect(messageTypeForFile('application/pdf')).toBe('file')
    expect(normalizeContentType('IMAGE/JPEG')).toBe('image/jpeg')
    expect(normalizeContentType('')).toBe('application/octet-stream')
    expect(normalizeContentType('weird type')).toBe('application/octet-stream')
  })

  it('formats sizes and durations', () => {
    expect(formatBytes(null)).toBe('')
    expect(formatBytes(12)).toBe('12 B')
    expect(formatBytes(840 * 1024)).toBe('840 KB')
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1.3 MB')
    expect(formatDuration(null)).toBe('')
    expect(formatDuration(42_000)).toBe('0:42')
    expect(formatDuration(725_000)).toBe('12:05')
  })
})

describe('poll payloads (votes are reactions)', () => {
  it('builds short option ids so a vote reaction fits the 16-character limit', () => {
    const payload = pollPayload('  Pizza or tacos?  ', ['Pizza', 'Tacos', 'Both'])
    const poll = parsePollPayload(payload)
    expect(poll?.question).toBe('Pizza or tacos?')
    expect(poll?.options.map((option) => option.id)).toEqual(['a', 'b', 'c'])
    expect(poll?.multiple).toBe(false)
    const reaction = pollVoteReaction('b')
    expect(reaction).toBe('poll:b')
    expect(reaction.length).toBeLessThanOrEqual(16)
    expect(isPollVoteReaction(reaction)).toBe(true)
    expect(isPollVoteReaction('❤️')).toBe(false)
    expect(pollOptionIdOf(reaction)).toBe('b')
    expect(pollOptionIdOf('👍')).toBeNull()
  })

  it('rejects polls with too few options', () => {
    expect(parsePollPayload(pollPayload('Q', ['only']))).toBeNull()
    expect(parsePollPayload({ question: 'Q' })).toBeNull()
  })
})

describe('place payloads', () => {
  it('carries the public place, never a device coordinate field', () => {
    const payload = placePayload({
      id: asPlaceId(fixtures.IDS.place),
      name: 'Dolores Park',
      areaId: asAreaId(fixtures.IDS.area),
      areaName: 'Mission',
      lat: 37.7596,
      lng: -122.4269,
      category: 'park',
      visibility: 'public',
    })
    expect(Object.keys(payload).sort()).toEqual([
      'areaName',
      'category',
      'lat',
      'lng',
      'name',
      'placeId',
    ])
    expect(parsePlacePayload(payload)?.name).toBe('Dolores Park')
    expect(parsePlacePayload({ name: 'x' })).toBeNull()
  })
})
