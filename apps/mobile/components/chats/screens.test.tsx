/**
 * The conversation surface mounted (SCREEN 10): the header's identity, presence line and the
 * contextual "N live · Join" row to the group's room, and the composer's plus sheet — exactly the
 * five actions of spec §75, with "Here" behind its flag.
 */
import { fixtures } from '@earth/api/testing'
import { ConversationDetailDtoSchema } from '@earth/domain'
import { copy } from '@earth/ui'
import { describe, expect, it } from 'vitest'

import { chatCopy } from '@/features/chats/copy'
import { render } from '@/test/render'

import { ConversationHeader } from './ConversationHeader'
import { PlusSheet } from './PlusSheet'

const detail = (overrides: Parameters<typeof fixtures.conversationDetail>[0] = {}) =>
  ConversationDetailDtoSchema.parse(fixtures.conversationDetail(overrides))

const noPresence = { typingNames: [], activeNames: [] }

describe('ConversationHeader (SCREEN 10)', () => {
  it('names the conversation, opens info, and shows no live line without a room', () => {
    const conversation = detail({ activeRoom: null })
    const opened: string[] = []
    const screen = render(
      <ConversationHeader
        conversation={conversation}
        presence={noPresence}
        liveCount={0}
        onBack={() => undefined}
        onOpenInfo={() => opened.push('info')}
        onJoinRoom={() => undefined}
      />,
    )
    expect(screen.text()).toContain(conversation.title)
    expect(screen.byLabel(chatCopy.back)).toHaveLength(1)
    expect(screen.text()).not.toContain(copy.liveJoinLine(2))
    screen.press(`${conversation.title} · ${chatCopy.openInfo}`)
    expect(opened).toEqual(['info'])
  })

  it('shows the typing line and the contextual live row that joins the room', () => {
    const conversation = detail({
      activeRoom: { roomId: fixtures.IDS.room, participantCount: 3 },
    })
    const joined: string[] = []
    const screen = render(
      <ConversationHeader
        conversation={conversation}
        presence={{ typingNames: ['Maya'], activeNames: ['Kavon'] }}
        liveCount={3}
        onBack={() => undefined}
        onOpenInfo={() => undefined}
        onJoinRoom={() => joined.push('room')}
      />,
    )
    expect(screen.text()).toContain('Maya typing…')
    expect(screen.text()).toContain(copy.liveJoinLine(3))
    screen.press(copy.liveJoinLine(3))
    expect(joined).toEqual(['room'])
  })

  it('renders a skeleton, and no identity, while the conversation loads', () => {
    const screen = render(
      <ConversationHeader
        conversation={undefined}
        presence={noPresence}
        liveCount={0}
        onBack={() => undefined}
        onOpenInfo={() => undefined}
        onJoinRoom={() => undefined}
      />,
    )
    expect(screen.byLabel(chatCopy.back)).toHaveLength(1)
    expect(screen.text()).toBe('')
  })
})

describe('PlusSheet (SCREEN 10)', () => {
  it('offers Photo/video, Poll, Place and Here — and hides Here without the flag', () => {
    const withHere = render(
      <PlusSheet open locationSharingEnabled onClose={() => undefined} onPick={() => undefined} />,
    )
    const text = withHere.text()
    expect(text).toContain(copy.composerActions.photoVideo)
    expect(text).toContain(copy.composerActions.poll)
    expect(text).toContain(copy.composerActions.place)
    expect(text).toContain(copy.composerActions.here)
    const flagOff = render(
      <PlusSheet
        open
        locationSharingEnabled={false}
        onClose={() => undefined}
        onPick={() => undefined}
      />,
    )
    expect(flagOff.text()).not.toContain(copy.composerActions.here)
    expect(flagOff.text()).toContain(copy.composerActions.place)
  })

  it('closes and reports the action that was picked', () => {
    const events: string[] = []
    const screen = render(
      <PlusSheet
        open
        locationSharingEnabled
        onClose={() => events.push('close')}
        onPick={(action) => events.push(action)}
      />,
    )
    screen.press(copy.composerActions.poll)
    expect(events).toEqual(['close', 'poll'])
  })
})
