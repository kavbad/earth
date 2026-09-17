/**
 * Screen-level rules that need no React Native: row lines (SCREEN 08), the presence line
 * (SCREEN 10), poll option validation and payload previews, recent people and selection
 * (SCREEN 09), message search and the "new group" rule behind "Bring them here" (SCREEN 12).
 */
import { fixtures } from '@earth/api/testing'
import {
  ConversationSummaryDtoSchema,
  GroupDetailDtoSchema,
  MessageDtoSchema,
  asHumanId,
} from '@earth/domain'
import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import {
  contentTypeForAsset,
  formatBytes,
  formatDuration,
  messagePreviewText,
  messageTypeForFile,
  normalizeContentType,
  parsePollPayload,
  pollOptionIdOf,
  pollPayload,
  pollVoteReaction,
  validPollOptions,
} from '../payloads'
import { createMemoryStorage } from '../storage'
import {
  DEFAULT_PREFS,
  canModerate,
  isNewGroup,
  memberRelationLine,
  parsePrefs,
  searchMessages,
} from './info'
import {
  chatRowLabel,
  dedupeConversations,
  filterConversations,
  presenceLine,
  previewLine,
} from './list'
import {
  RECENT_PEOPLE_MAX,
  readRecentPeople,
  recentPeople,
  rememberRecentPeople,
  toggleSelected,
} from './recentPeople'

const XAVIER = asHumanId(fixtures.IDS.xavier)
const MAYA = asHumanId(fixtures.IDS.maya)

const summary = (overrides: Parameters<typeof fixtures.conversationSummary>[0] = {}) =>
  ConversationSummaryDtoSchema.parse(fixtures.conversationSummary(overrides))

describe('SCREEN 08 row lines', () => {
  it('reads "Sender: preview" in groups, "You:" for own messages, bare text in DMs', () => {
    const group = summary()
    expect(previewLine(group, XAVIER)).toBe('Maya: Anyone around tonight?')
    expect(previewLine(group, MAYA)).toBe('You: Anyone around tonight?')
    const direct = summary({ type: 'direct', groupId: null })
    expect(previewLine(direct, XAVIER)).toBe('Anyone around tonight?')
    const photo = summary({
      lastMessage: {
        id: fixtures.IDS.message,
        senderHumanId: MAYA,
        senderDisplayName: 'Dad',
        type: 'image',
        text: null,
        createdAt: fixtures.AT,
      },
    })
    expect(previewLine(photo, XAVIER)).toBe('Dad: Photo')
    expect(copy.chatRowLine('Family', previewLine(photo, XAVIER))).toBe('Family — Dad: Photo')
    expect(previewLine(summary({ lastMessage: null }), XAVIER)).toBe('')
    expect(chatRowLabel({ title: 'Family', unreadCount: 3 }, 'Dad: Photo')).toBe(
      'Family — Dad: Photo · 3 unread',
    )
    expect(chatRowLabel({ title: 'Family', unreadCount: 0 }, '')).toBe('Family')
  })

  it('filters loaded rows by name and last message and dedupes pages', () => {
    const rows = [summary(), summary({ id: fixtures.IDS.group, title: 'Family' })]
    expect(filterConversations(rows, '')).toHaveLength(2)
    expect(filterConversations(rows, 'fam').map((row) => row.title)).toEqual(['Family'])
    expect(filterConversations(rows, 'tonight')).toHaveLength(2)
    expect(filterConversations(rows, 'zzz')).toHaveLength(0)
    expect(
      dedupeConversations([{ conversations: rows }, { conversations: [rows[0]!] }]),
    ).toHaveLength(2)
  })
})

describe('SCREEN 10 presence line', () => {
  it('prefers typing over active and names people the Live way', () => {
    expect(presenceLine({ typingNames: [], activeNames: [] })).toBe('')
    expect(presenceLine({ typingNames: ['Maya'], activeNames: ['Kavon'] })).toBe('Maya typing…')
    expect(presenceLine({ typingNames: [], activeNames: ['Maya', 'Kavon', 'Ben'] })).toBe(
      'Maya, Kavon + 1 active',
    )
  })
})

describe('payloads', () => {
  it('builds and parses polls, votes as reactions', () => {
    const payload = pollPayload(' Pizza? ', ['Yes', 'No'])
    const poll = parsePollPayload(payload)
    expect(poll?.question).toBe('Pizza?')
    expect(poll?.options.map((option) => option.id)).toEqual(['a', 'b'])
    expect(pollVoteReaction('a')).toBe('poll:a')
    expect(pollOptionIdOf('poll:b')).toBe('b')
    expect(pollOptionIdOf('❤️')).toBeNull()
    expect(validPollOptions([' Yes ', '', 'No'])).toEqual(['Yes', 'No'])
    expect(parsePollPayload({})).toBeNull()
  })

  it('previews, content types and formats', () => {
    expect(messagePreviewText('image', null)).toBe('Photo')
    expect(messagePreviewText('text', '  hello   world ')).toBe('hello world')
    expect(messageTypeForFile('image/heic')).toBe('image')
    expect(messageTypeForFile('video/quicktime')).toBe('video')
    expect(messageTypeForFile('application/pdf')).toBe('file')
    expect(normalizeContentType(undefined)).toBe('application/octet-stream')
    expect(normalizeContentType('IMAGE/JPEG')).toBe('image/jpeg')
    expect(contentTypeForAsset({ uri: 'file:///a/b.MOV', type: 'video' })).toBe('video/quicktime')
    expect(contentTypeForAsset({ uri: 'file:///a/b', type: 'image' })).toBe('image/jpeg')
    expect(contentTypeForAsset({ uri: 'file:///a/b', mimeType: 'image/png' })).toBe('image/png')
    expect(formatBytes(1536)).toBe('2 KB')
    expect(formatBytes(2_621_440)).toBe('2.5 MB')
    expect(formatDuration(65_000)).toBe('1:05')
    expect(formatDuration(null)).toBe('')
  })
})

describe('SCREEN 09 recent people and selection', () => {
  const person = (humanId: string, displayName: string) => ({
    humanId: asHumanId(humanId),
    displayName,
    handle: null,
    avatarUrl: null,
  })

  it('offers remembered picks then recent senders, never the viewer, capped', () => {
    const remembered = [person(fixtures.IDS.kavon, 'Kavon')]
    const conversations = [
      summary(),
      summary({
        id: fixtures.IDS.group,
        lastMessage: { ...summary().lastMessage!, senderHumanId: XAVIER },
      }),
    ]
    const people = recentPeople(remembered, conversations, XAVIER)
    expect(people.map((p) => p.displayName)).toEqual(['Kavon', 'Maya'])
    expect(recentPeople(remembered, conversations, null)).toEqual([])
    const many = Array.from({ length: RECENT_PEOPLE_MAX + 3 }, (_, index) =>
      person(`00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`, `P${index}`),
    )
    expect(recentPeople(many, [], XAVIER)).toHaveLength(RECENT_PEOPLE_MAX)
  })

  it('remembers picks on the device and toggles a selection', async () => {
    const store = createMemoryStorage()
    await rememberRecentPeople(store, XAVIER, [person(fixtures.IDS.maya, 'Maya')])
    await rememberRecentPeople(store, XAVIER, [person(fixtures.IDS.kavon, 'Kavon')])
    expect((await readRecentPeople(store, XAVIER)).map((p) => p.displayName)).toEqual([
      'Kavon',
      'Maya',
    ])
    expect(await readRecentPeople(null, XAVIER)).toEqual([])
    const maya = person(fixtures.IDS.maya, 'Maya')
    expect(toggleSelected([], maya)).toEqual([maya])
    expect(toggleSelected([maya], maya)).toEqual([])
  })
})

describe('SCREEN 12 rules', () => {
  const group = (overrides: Parameters<typeof fixtures.groupDetail>[0] = {}) =>
    GroupDetailDtoSchema.parse(fixtures.groupDetail(overrides))
  const message = (overrides: Parameters<typeof fixtures.messageDto>[0] = {}) =>
    MessageDtoSchema.parse(fixtures.messageDto(overrides))

  it('treats a mostly-founder or week-old group as new', () => {
    const now = new Date('2026-09-10T12:00:00Z')
    expect(isNewGroup(group({ memberCount: 2, createdAt: '2026-01-01T00:00:00Z' }), now)).toBe(true)
    expect(isNewGroup(group({ memberCount: 9, createdAt: '2026-09-08T00:00:00Z' }), now)).toBe(true)
    expect(isNewGroup(group({ memberCount: 9, createdAt: '2026-08-01T00:00:00Z' }), now)).toBe(
      false,
    )
  })

  it('searches loaded messages, newest first, skipping deleted ones', () => {
    const messages = [
      message({ id: fixtures.IDS.message, text: 'Dinner at 8', createdAt: '2026-09-03T06:00:00Z' }),
      message({
        id: fixtures.IDS.message2,
        text: 'dinner moved',
        createdAt: '2026-09-03T07:00:00Z',
      }),
      message({ id: fixtures.IDS.reply, text: 'dinner cancelled', deletedAt: fixtures.AT }),
    ]
    expect(searchMessages(messages, 'DINNER').map((m) => m.id)).toEqual([
      fixtures.IDS.message2,
      fixtures.IDS.message,
    ])
    expect(searchMessages(messages, '')).toEqual([])
  })

  it('labels roles and moderation', () => {
    expect(memberRelationLine({ role: 'owner', isFriend: true })).toBe('Owner · Friend')
    expect(memberRelationLine({ role: 'member', isFriend: false })).toBe('')
    expect(canModerate('moderator')).toBe(true)
    expect(canModerate('member')).toBe(false)
    expect(canModerate(null)).toBe(false)
    expect(parsePrefs({ muteState: 'muted', notificationLevel: 'none' })).toEqual({
      muteState: 'muted',
      notificationLevel: 'none',
    })
    expect(parsePrefs({ muteState: 'loud' })).toBeNull()
    expect(DEFAULT_PREFS).toEqual({ muteState: 'none', notificationLevel: 'all' })
  })
})
