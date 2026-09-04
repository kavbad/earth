/**
 * Screen-level rules that need no providers: row lines (SCREEN 08), the presence line
 * (SCREEN 10), the plus sheet's spec actions, poll option validation, message search and the
 * "new group" rule behind "Bring them here" (SCREEN 12).
 */
import { fixtures } from '@earth/api/testing'
import { ConversationSummaryDtoSchema, MessageDtoSchema, asHumanId } from '@earth/domain'
import { copy } from '@earth/ui'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { previewLine } from './ChatRow'
import { filterConversations } from './ChatsList'
import { presenceLine } from './ConversationHeader'
import { isNewGroup, searchMessages } from './ConversationInfo'
import { PlusSheet } from './PlusSheet'
import { validPollOptions } from './PollComposer'

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
  })

  it('filters loaded rows by name and last message', () => {
    const rows = [summary(), summary({ id: fixtures.IDS.group, title: 'Family' })]
    expect(filterConversations(rows, '')).toHaveLength(2)
    expect(filterConversations(rows, 'fam').map((row) => row.title)).toEqual(['Family'])
    expect(filterConversations(rows, 'tonight')).toHaveLength(2)
    expect(filterConversations(rows, 'zzz')).toHaveLength(0)
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

describe('plus sheet (SCREEN 10)', () => {
  it('offers exactly Photo/video, File, Poll, Place, Here — and hides Here without the flag', () => {
    const on = renderToStaticMarkup(
      <PlusSheet open locationSharingEnabled onClose={() => undefined} onPick={() => undefined} />,
    )
    for (const label of Object.values(copy.composerActions)) expect(on).toContain(label)
    expect((on.match(/<button/g) ?? []).length).toBe(5)
    const off = renderToStaticMarkup(
      <PlusSheet
        open
        locationSharingEnabled={false}
        onClose={() => undefined}
        onPick={() => undefined}
      />,
    )
    expect(off).not.toContain(`>${copy.composerActions.here}<`)
    expect((off.match(/<button/g) ?? []).length).toBe(4)
  })

  it('keeps only non-blank poll options', () => {
    expect(validPollOptions([' Pizza ', '', '  ', 'Tacos'])).toEqual(['Pizza', 'Tacos'])
  })
})

describe('SCREEN 12 helpers', () => {
  it('searches loaded messages case-insensitively, newest first, skipping tombstones', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 8, 3, 12, minute)).toISOString()
    const messages = [
      MessageDtoSchema.parse(fixtures.messageDto({ text: 'Dinner at 8', createdAt: at(1) })),
      MessageDtoSchema.parse(
        fixtures.messageDto({ id: fixtures.IDS.group, text: 'dinner moved', createdAt: at(2) }),
      ),
      MessageDtoSchema.parse(
        fixtures.messageDto({
          id: fixtures.IDS.room,
          text: null,
          payload: {},
          deletedAt: at(3),
          createdAt: at(3),
        }),
      ),
    ]
    expect(searchMessages(messages, 'DINNER').map((m) => m.text)).toEqual([
      'dinner moved',
      'Dinner at 8',
    ])
    expect(searchMessages(messages, '  ')).toEqual([])
  })

  it('treats a small or week-old group as new for "Bring them here"', () => {
    const now = new Date('2026-09-03T12:00:00Z')
    expect(isNewGroup({ memberCount: 1, createdAt: '2020-01-01T00:00:00Z' }, now)).toBe(true)
    expect(isNewGroup({ memberCount: 12, createdAt: '2026-09-01T00:00:00Z' }, now)).toBe(true)
    expect(isNewGroup({ memberCount: 12, createdAt: '2026-06-01T00:00:00Z' }, now)).toBe(false)
  })
})
