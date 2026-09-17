import { NOTIFICATION_TYPES } from '@earth/domain'
import { describe, expect, it } from 'vitest'

import {
  INITIAL_PUSH_STATE,
  PUSH_CHANNEL_SPECS,
  type PushRegistrationState,
  foregroundLine,
  interestReasonForPathname,
  needsRegistration,
  nextPushAction,
  pushChannelFor,
  pushPlatformFor,
  registrationKey,
  shouldPresentInForeground,
} from './push'

const ROOM = '11111111-1111-4111-8111-111111111111'
const CONVERSATION = '22222222-2222-4222-8222-222222222222'

function state(patch: Partial<PushRegistrationState>): PushRegistrationState {
  return { ...INITIAL_PUSH_STATE, ...patch }
}

describe('nextPushAction', () => {
  const base = {
    humanId: 'h1',
    isDevice: true,
    online: true,
    interested: false,
    state: INITIAL_PUSH_STATE,
  }

  it('never acts for a Visitor, on a simulator, or offline', () => {
    expect(nextPushAction({ ...base, humanId: null })).toBe('none')
    expect(nextPushAction({ ...base, humanId: null, interested: true })).toBe('none')
    expect(nextPushAction({ ...base, isDevice: false })).toBe('none')
    expect(nextPushAction({ ...base, online: false })).toBe('none')
  })

  it('reads what the OS remembers first, then registers silently when it was granted', () => {
    expect(nextPushAction(base)).toBe('read_permission')
    expect(nextPushAction({ ...base, state: state({ permission: 'granted' }) })).toBe('register')
  })

  it('asks only at a meaningful moment, never on app open', () => {
    const undetermined = state({ permission: 'undetermined' })
    expect(nextPushAction({ ...base, state: undetermined })).toBe('none')
    expect(nextPushAction({ ...base, state: undetermined, interested: true })).toBe(
      'request_permission',
    )
  })

  it('respects a refusal for the rest of the process', () => {
    const denied = state({ permission: 'denied' })
    expect(nextPushAction({ ...base, state: denied, interested: true })).toBe('none')
  })
})

describe('token registration', () => {
  it('re-sends when the token or the Human changed', () => {
    const registered = state({ permission: 'granted', registeredKey: registrationKey('h1', 't1') })
    expect(needsRegistration(registered, 'h1', 't1')).toBe(false)
    expect(needsRegistration(registered, 'h1', 't2')).toBe(true)
    expect(needsRegistration(registered, 'h2', 't1')).toBe(true)
  })

  it('maps the OS to a push platform', () => {
    expect(pushPlatformFor('ios')).toBe('ios')
    expect(pushPlatformFor('android')).toBe('android')
  })
})

describe('interest', () => {
  it('counts the Live tab, a room and Notifications as meaningful moments', () => {
    expect(interestReasonForPathname('/live')).toBe('live')
    expect(interestReasonForPathname('/live/token')).toBe('live')
    expect(interestReasonForPathname(`/rooms/${ROOM}`)).toBe('room')
    expect(interestReasonForPathname('/notifications')).toBe('notifications')
    expect(interestReasonForPathname('/home')).toBeNull()
    expect(interestReasonForPathname('/chats/abc')).toBeNull()
    expect(interestReasonForPathname('/livestream')).toBeNull()
  })
})

describe('Android channels', () => {
  it('maps every notification type to one of the three channels, Lives to the high one', () => {
    const ids = new Set(PUSH_CHANNEL_SPECS.map((spec) => spec.id))
    expect([...ids].sort()).toEqual(['live', 'messages', 'social'])
    for (const type of NOTIFICATION_TYPES) expect(ids.has(pushChannelFor(type))).toBe(true)
    expect(pushChannelFor('friend_live')).toBe('live')
    expect(pushChannelFor('multi_live')).toBe('live')
    expect(pushChannelFor('group_live')).toBe('live')
    expect(pushChannelFor('direct_message')).toBe('messages')
    expect(pushChannelFor('group_message')).toBe('messages')
    expect(pushChannelFor('friend_request')).toBe('social')
    expect(pushChannelFor('group_invitation')).toBe('social')
  })

  it('gives Live high importance and keeps social quiet', () => {
    const byId = Object.fromEntries(PUSH_CHANNEL_SPECS.map((spec) => [spec.id, spec]))
    expect(byId['live']?.importance).toBe('high')
    expect(byId['messages']?.importance).toBe('default')
    expect(byId['social']?.importance).toBe('low')
    expect(byId['social']?.sound).toBe(false)
    for (const spec of PUSH_CHANNEL_SPECS) expect(spec.name.length).toBeGreaterThan(0)
  })
})

describe('foreground', () => {
  it('hides a push that names the conversation or room the person is in', () => {
    const message = { type: 'direct_message', conversationId: CONVERSATION }
    expect(shouldPresentInForeground(message, `/chats/${CONVERSATION}`)).toBe(false)
    expect(shouldPresentInForeground(message, `/chats/${CONVERSATION}/info`)).toBe(false)
    expect(shouldPresentInForeground(message, '/chats')).toBe(true)
    expect(shouldPresentInForeground(message, '/chats/other')).toBe(true)
    const live = { type: 'friend_live', objectType: 'room', objectId: ROOM }
    expect(shouldPresentInForeground(live, `/rooms/${ROOM}`)).toBe(false)
    expect(shouldPresentInForeground(live, '/live')).toBe(true)
    expect(shouldPresentInForeground(null, '/home')).toBe(true)
  })

  it('renders the spec line and nothing for an empty push', () => {
    expect(foregroundLine('Xavier is live', 'Cooking dinner')).toBe(
      'Xavier is live — Cooking dinner',
    )
    expect(foregroundLine('Maya wants to be friends', '')).toBe('Maya wants to be friends')
    expect(foregroundLine(null, undefined)).toBeNull()
  })
})
